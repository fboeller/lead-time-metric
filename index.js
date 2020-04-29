const fetch = require('node-fetch');
const net = require('net');
const parseLinkHeader = require('parse-link-header');
const _ = require('lodash');
const fs = require('fs');
const util = require('util');

const environment = {
    githubApiToken: process.env.GITHUB_API_TOKEN // Export GITHUB_API_TOKEN on your shell
};

const repos = [
    // { orga: 'arrow-kt', name: 'arrow', baseBranch: 'master' },
    // { orga: 'arrow-kt', name: 'arrow-core', baseBranch: 'master' },
    { orga: 'JasonEtco', name: 'create-an-issue', baseBranch: 'master' },
];

function handleError(response, token) {
    if (!response.ok) {
        fetchGitHubRateLimit(token).then(console.log);
        throw new Error('Network response was not ok: ' + response.statusText);
    }
    return response;
}

function removeNonWorkingHours(seconds) {
    const noWorkPeriods = Math.floor(seconds / 60 / 60 / 16);
    return seconds - noWorkPeriods * 16 * 60 * 60;
}

function computeBranchLifeTimeInSeconds(commits, mergedAt) {
    const firstCommitDate = commits[0].commit.committer.date;
    const durationMs = Date.parse(mergedAt) - Date.parse(firstCommitDate);
    return removeNonWorkingHours(Math.ceil(durationMs / 1000));
}

async function fetchBranchLifeTimes(token, repo, pagedPrUrl, doneUntil) {
    return fetch(pagedPrUrl, createGitHubRequestObject(token))
        .then(response => handleError(response, token))
        .then(async response => {
            const prs = await response.json();
            const results = await Promise.all(prs
                .filter(pr => pr.merged_at)
                .filter(pr => !doneUntil || Date.parse(pr.merged_at) > Date.parse(doneUntil))
                .map(pr =>
                    fetch(pr._links.commits.href, createGitHubRequestObject(token))
                        .then(response => handleError(response, token))
                        .then(response => response.json())
                        .then(commits => ({
                            baseBranch: repo.baseBranch,
                            repository: repo.orga + "/" + repo.name,
                            merged_at: pr.merged_at,
                            durationSec: computeBranchLifeTimeInSeconds(commits, pr.merged_at)
                        }))
                )
            ).catch(reason => {
                console.error("Could not fetch commits of PRs.");
                console.error(prs.map(pr => pr.url));
                console.error(reason);
                return [];
            });
            const linkHeader = parseLinkHeader(response.headers.get('Link'));
            if (linkHeader && linkHeader.next && results.length > 0) {
                return fetchBranchLifeTimes(token, repo, linkHeader.next.url)
                    .then(nextResults => results.concat(nextResults));
            } else {
                return results;
            }
        }).catch(reason => {
            console.error("Could not fetch any PRs!");
            console.error(reason);
            return [];
        });
}

function createGitHubRequestObject(token) {
    return {
        headers: {
            'Authorization': "token " + token
        }
    };
}

function fetchGitHubRateLimit(token) {
    return fetch("https://api.github.com/rate_limit", createGitHubRequestObject(token))
        .then(response => response.json());
}

async function fetchMergeUntilReleaseTime(branchLifeTime) {
    // TODO Since GitHub pages the commits and also always gives us the latest commits first, this is not correct.
    return fetch("https://api.github.com/repos/leanix/" + branchLifeTime.repository + "/commits?sha=" + branchLifeTime.baseBranch + "&since=" + branchLifeTime.merged_at, createGitHubRequestObject(environment.githubApiToken))
        .then((response) => {
            if (!response.ok) {
                throw new Error('Network response was not ok: ' + response.statusText);
            }
            return response.json();
        })
        .then(commits => commits
            .map(commit => commit.commit)
            .filter(commit => commit.message.startsWith("Merge release branch"))
        )
        .then(commits => commits[commits.length - 1])
        .then(commit => commit.committer.date)
        .then(commitDate => Date.parse(commitDate) - Date.parse(branchLifeTime.merged_at))
        .then(durationMs => Math.ceil(durationMs / 1000 / 60))
        .then(untilReleaseMin => ({
            repository: branchLifeTime.repository,
            merged_at: branchLifeTime.merged_at,
            untilReleaseMin
        })).catch((reason) => {
            console.error("Could not fetch commits since merge commit.");
            console.error(reason);
            console.error(branchLifeTime);
            return [];
        });
}

function sendMetrics(points) {
    console.log("Start sending points to graphite...");
    var socket = net.createConnection(2003, "127.0.0.1", () => {
        for (const p of points) {
            console.log(`${p.stat} ${p.value} ${p.timestamp}`);
            socket.write(`${p.stat} ${p.value} ${p.timestamp}\n`);
        }
        socket.end();
        console.log("Finished sending points to graphite.");
    });
}

async function fetchBranchLifeTimesOfRepos() {
    const fetchInfoBefore = await util.promisify(fs.readFile)('fetch_info.json', 'utf8').then(JSON.parse).catch(err => []);
    console.log("Found fetch information.");
    console.log(fetchInfoBefore);
    console.log("Start fetching branch life times...");
    const branchLifeTimesPerRepo = await Promise.all(repos.map(async repo => {
        const repoId = repo.orga + "/" + repo.name;
        const rateLimit = await fetchGitHubRateLimit(environment.githubApiToken);
        console.log("Remaining GitHub requests: " + rateLimit.resources.core.remaining);
        console.log("Processing '" + repoId + "'...");
        const doneUntil = _.find(fetchInfoBefore, info => info.repository == repoId);
        const initialPagePrUrl = "https://api.github.com/repos/" + repoId + "/pulls?state=closed&base=" + repo.baseBranch + "&sort=updated&direction=desc&per_page=100";
        return await fetchBranchLifeTimes(environment.githubApiToken, repo, initialPagePrUrl, doneUntil);
    }));
    console.log("Finished fetching branch life times.");
    console.log("Updating fetch information...");
    const fetchInfoAfter = branchLifeTimesPerRepo
        .map(branchLifeTimes => branchLifeTimes[0])
        .filter(branchLifeTime => branchLifeTime)
        .map(branchLifeTime => ({
            repository: branchLifeTime.repository,
            doneUntil: branchLifeTime.merged_at
        }));
    const mergedFetchInfo = _.uniqBy(fetchInfoAfter.concat(fetchInfoBefore), 'repository');
    await util.promisify(fs.writeFile)('fetch_info.json', JSON.stringify(mergedFetchInfo));
    console.log("Updated fetch information.");
    console.log(mergedFetchInfo);
    return _.flatten(branchLifeTimesPerRepo);
}

async function fetchAndUpdateMergeUntilReleaseTimes() {
    console.log("Start fetching merge-until-release times...");
    const mergeUntilReleaseTimes = await Promise.all(branchLifeTimes
        .filter(branchLifeTime => branchLifeTime.baseBranch != 'master')
        .map(branchLifeTime => fetchMergeUntilReleaseTime(branchLifeTime))
    );
    console.log(mergeUntilReleaseTimes);
    console.log("Finished fetching merge-until-release times.");
}

async function main() {
    const branchLifeTimes = await fetchBranchLifeTimesOfRepos();
    console.log(branchLifeTimes);
    // fetchAndUpdateMergeUntilReleaseTimes();

    const points = branchLifeTimes.map(point => ({
        stat: "leadtime.branchlifetime." + point.repository.replace(/\//g, "-"),
        value: point.durationSec,
        timestamp: Math.ceil(Date.parse(point.merged_at) / 1000)
    }));

    sendMetrics(points);
}

main();