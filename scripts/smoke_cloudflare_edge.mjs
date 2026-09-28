/* global console, process, fetch */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  isRemovedVercelDeployment,
  isVercelProtectedRedirect,
} from "./assert_vercel_edge_route_policy.mjs";

const defaultHosts = [
  "myscube.myscguard.app",
  "devops.myscguard.app",
  "drive.myscguard.app",
  "github.myscguard.app",
  "firestore.myscguard.app",
  "audit.myscguard.app",
  "edge.myscguard.app",
];

const hosts = (process.env.CLOUDFLARE_EDGE_HOSTS || defaultHosts.join(","))
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const requireCloudflare = process.env.CLOUDFLARE_EDGE_REQUIRE_CLOUDFLARE === "1";
const requireRedirects = process.env.CLOUDFLARE_EDGE_REQUIRE_REDIRECTS === "1";
const allowCloudflareChallenge = process.env.CLOUDFLARE_EDGE_ALLOW_CHALLENGE === "1";
const outputPath = process.env.CLOUDFLARE_EDGE_SMOKE_OUTPUT || "tmp/edge-smoke/cloudflare-edge-smoke.json";
const expectedTitle = "MYSCube InnerPlatform";
const defaultDirectHosts = [
  "inner-platform.vercel.app",
  "inner-platform-h799435np-merryai-devs-projects.vercel.app",
  "inner-platform-dsk6wdc3e-merryai-devs-projects.vercel.app",
  "inner-platform-gq6813nqh-merryai-devs-projects.vercel.app",
  "inner-platform-k2x121b33-merryai-devs-projects.vercel.app",
  "inner-platform-f52434-routes-merryai-devs-projects.vercel.app",
  "submit-mysc.com",
  "inner-platform-merryai-devs-projects.vercel.app",
  "inner-platform-merryai-dev-merryai-devs-projects.vercel.app",
];
const directHosts = (process.env.CLOUDFLARE_EDGE_DIRECT_HOSTS || defaultDirectHosts.join(","))
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const defaultLegacyRedirects = [];
const legacyRedirects = (process.env.CLOUDFLARE_EDGE_LEGACY_REDIRECTS || defaultLegacyRedirects.map((item) => `${item.host}->${item.target}`).join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const [host, target] = item.split("->").map((part) => part.trim());
    return { host, target };
  })
  .filter((item) => item.host && item.target);

function result(name, ok, details = {}) {
  return { name, ok, ...details };
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

function resolveViaPublicDns(host) {
  for (const resolver of ["1.1.1.1", "8.8.8.8"]) {
    const dns = run("dig", [`@${resolver}`, "+short", host, "A"]);
    const addresses = dns.stdout
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => /^\d+\.\d+\.\d+\.\d+$/.test(item));
    const cloudflareAddress = addresses.find((address) => address !== "76.76.21.21");
    if (cloudflareAddress) {
      return { resolver, address: cloudflareAddress, addresses };
    }
  }
  return null;
}

function curlHead(url, host, address) {
  const args = ["-sI", "--max-time", "15"];
  if (host && address) args.push("--resolve", `${host}:443:${address}`);
  args.push(url);
  const curl = run("curl", args);
  const text = `${curl.stdout || ""}${curl.stderr || ""}`;
  const status = Number.parseInt(text.match(/^HTTP\/\S+\s+(\d+)/im)?.[1] || "0", 10);
  const headers = Object.fromEntries(text
    .split(/\r?\n/)
    .map((line) => line.match(/^([^:]+):\s*(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].toLowerCase(), match[2]]));
  return { status, headers, text, ok: curl.status === 0 };
}

async function fetchText(url, init = {}) {
  const response = await fetch(url, {
    redirect: init.redirect || "follow",
    headers: {
      "user-agent": "MYSCube-edge-smoke/1.0",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  return { response, text };
}

async function checkHost(host) {
  try {
    if (requireCloudflare) {
      const resolved = resolveViaPublicDns(host);
      if (!resolved) {
        return result(`https://${host}/`, false, { error: "Public DNS did not return a Cloudflare edge A record." });
      }
      const response = curlHead(`https://${host}/`, host, resolved.address);
      const server = response.headers.server || "";
      const cfRay = response.headers["cf-ray"] || "";
      const cloudflareOk = server.toLowerCase().includes("cloudflare") || Boolean(cfRay);
      const statusOk = (response.status >= 200 && response.status < 400)
        || (allowCloudflareChallenge && response.status === 403 && cloudflareOk);
      return result(`https://${host}/`, statusOk && cloudflareOk, {
        status: response.status,
        titleOk: true,
        cloudflareOk,
        allowCloudflareChallenge,
        server,
        cfRay: cfRay ? "present" : "missing",
        resolver: resolved.resolver,
        resolvedAddress: resolved.address,
      });
    }
    const { response, text } = await fetchText(`https://${host}/`);
    const server = response.headers.get("server") || "";
    const cfRay = response.headers.get("cf-ray") || "";
    const titleOk = text.includes(expectedTitle);
    const cloudflareOk = !requireCloudflare || server.toLowerCase().includes("cloudflare") || Boolean(cfRay);
    return result(`https://${host}/`, response.ok && titleOk && cloudflareOk, {
      status: response.status,
      titleOk,
      cloudflareOk,
      server,
      cfRay: cfRay ? "present" : "missing",
    });
  } catch (error) {
    return result(`https://${host}/`, false, { error: error.message });
  }
}

async function checkPathBlocked(host, path) {
  try {
    if (requireCloudflare) {
      const resolved = resolveViaPublicDns(host);
      if (!resolved) {
        return result(`https://${host}${path}`, false, { error: "Public DNS did not return a Cloudflare edge A record." });
      }
      const response = curlHead(`https://${host}${path}`, host, resolved.address);
      return result(`https://${host}${path}`, response.status === 403, {
        status: response.status,
        expected: 403,
        resolver: resolved.resolver,
        resolvedAddress: resolved.address,
        server: response.headers.server || "",
        cfRay: response.headers["cf-ray"] ? "present" : "missing",
      });
    }
    const { response } = await fetchText(`https://${host}${path}`, { redirect: "manual" });
    return result(`https://${host}${path}`, response.status === 403, {
      status: response.status,
      expected: 403,
    });
  } catch (error) {
    return result(`https://${host}${path}`, false, { error: error.message });
  }
}

async function checkDirectOrigin(host) {
  try {
    const response = await fetch(`https://${host}/`, {
      redirect: "manual",
      headers: { "user-agent": "MYSCube-edge-smoke/1.0" },
    });
    const location = response.headers.get("location") || "";
    const vercelError = response.headers.get("x-vercel-error") || "";
    const canonicalRedirect = response.status >= 300 && response.status < 400 && location.startsWith("https://myscube.myscguard.app/");
    const protectedRedirect = isVercelProtectedRedirect(response.status, location);
    const removedAlias = isRemovedVercelDeployment(response.status, vercelError);
    return result(`https://${host}/ direct-origin`, canonicalRedirect || protectedRedirect || removedAlias, {
      status: response.status,
      location,
      vercelError,
      canonicalRedirect,
      protectedRedirect,
      removedAlias,
    });
  } catch (error) {
    return result(`https://${host}/ direct-origin`, false, { error: error.message });
  }
}

async function checkLegacyRedirect({ host, target }) {
  try {
    const response = await fetch(`https://${host}/`, {
      redirect: "manual",
      headers: { "user-agent": "MYSCube-edge-smoke/1.0" },
    });
    const location = response.headers.get("location") || "";
    return result(`https://${host}/ legacy-redirect`, response.status >= 300 && response.status < 400 && location === target, {
      status: response.status,
      location,
      expected: target,
    });
  } catch (error) {
    return result(`https://${host}/ legacy-redirect`, false, { error: error.message });
  }
}

const checks = [];
for (const host of hosts) {
  checks.push(await checkHost(host));
}

if (requireCloudflare) {
  checks.push(await checkPathBlocked("edge.myscguard.app", "/.env"));
  checks.push(await checkPathBlocked("edge.myscguard.app", "/?q=../"));
}

if (requireRedirects) {
  for (const redirect of legacyRedirects) {
    checks.push(await checkLegacyRedirect(redirect));
  }
  for (const host of directHosts) {
    checks.push(await checkDirectOrigin(host));
  }
}

const payload = {
  ok: checks.every((check) => check.ok),
  generatedAt: new Date().toISOString(),
  requireCloudflare,
  requireRedirects,
  allowCloudflareChallenge,
  expectedTitle,
  checks,
};

fs.mkdirSync(outputPath.split("/").slice(0, -1).join("/"), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name} status=${check.status ?? "n/a"}`);
}

if (!payload.ok) {
  console.error(`Cloudflare edge smoke failed. Evidence written to ${outputPath}`);
  process.exit(1);
}

console.log(`Cloudflare edge smoke passed. Evidence written to ${outputPath}`);
