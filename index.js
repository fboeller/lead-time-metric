const fetch = require('node-fetch');
const net = require('net');
const parseLinkHeader = require('parse-link-header');
const _ = require('lodash');

const environment = {
    githubApiToken: process.env.GITHUB_API_TOKEN // Export GITHUB_API_TOKEN on your shell
};

const repos = [
    { orga: 'arrow-kt', name: 'arrow', baseBranch: 'master' },
    { orga: 'JasonEtco', name: 'create-an-issue', baseBranch: 'master' },
];

function removeNonWorkingHours(seconds) {
    const noWorkPeriods = Math.floor(seconds / 60 / 60 / 16);
    return seconds - noWorkPeriods * 16 * 60 * 60;
}

function handleError(response, token) {
    if (!response.ok) {
        fetchGitHubRateLimit(token).then(console.log);
        throw new Error('Network response was not ok: ' + response.statusText);
    }
    return response;
}

async function fetchBranchLifeTimes(token, repo, pagedPrUrl) {
    // TODO Resolve all pages to get all pull requests of a repository.
    // The maximum page size is 100
    // Note: GitHub rate limits its API.
    return fetch(pagedPrUrl, createGitHubRequestObject(token))
        .then(response => handleError(response, token))
        .then(async response => {
            const prs = await response.json();
            return Promise.all(prs.filter(pr => pr.merged_at)
                .map(pr =>
                    fetch(pr._links.commits.href, createGitHubRequestObject(token))
                        .then(response => handleError(response, token))
                        .then(response => response.json())
                        .then(commits => commits.map(commit => commit.commit.committer.date)[0])
                        .then(commit => Date.parse(pr.merged_at) - Date.parse(commit))
                        .then(durationMs => ({
                            baseBranch: repo.baseBranch,
                            repository: repo.name,
                            merged_at: pr.merged_at,
                            durationSec: removeNonWorkingHours(Math.ceil(durationMs / 1000))
                        }))
                )
            ).catch(reason => {
                console.error("Could not fetch commits of PR " + pr.url);
                console.error(reason);
                return [];
            })
            // .then(results => ({ results, pageInfo: parseLinkHeader(response.headers.get('Link')) }))
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
    return fetch("https://api.github.com/rate_limit", createGitHubRequestObject(token));
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
    console.log("Start fetching branch life times...");
    const branchLifeTimes = await Promise.all(repos.map(repo => {
        const initialPagePrUrl = "https://api.github.com/repos/" + repo.orga + "/" + repo.name + "/pulls?state=closed&base=" + repo.baseBranch + "&per_page=10";
        return fetchBranchLifeTimes(environment.githubApiToken, repo, initialPagePrUrl);
    })).then(_.flatten);
    console.log("Finished fetching branch life times.");
    return branchLifeTimes;
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
        stat: "leadtime.branchlifetime." + point.repository,
        value: point.durationSec,
        timestamp: Math.ceil(Date.parse(point.merged_at) / 1000)
    }));

    sendMetrics(points);
}

main();