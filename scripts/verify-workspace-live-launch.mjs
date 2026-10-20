import puppeteer from 'puppeteer-core';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const reportPath = resolve('logs/workspace-live-launch-result.json');
const request = {
  target: 'relay', platformId: 'chatgpt', purpose: 'agent',
  count: 2, orchestratorBrain: 'web', coordinateTasks: true,
  launchCoordinator: true, coordinatorCount: 1, sessionMode: 'clean',
};
if (existsSync(reportPath)) {
  throw new Error('A launch report already exists. Inspect it before another launch; this script does not retry.');
}
const report = { status: 'preparing', startedAt: new Date().toISOString(), request, pid: process.pid };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
save();
let browser;
try {
  browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9405' });
  const pages = await browser.pages();
  let page = pages.find(item => new URL(item.url()).origin === 'http://127.0.0.1:3007');
  if (!page) {
    page = await browser.newPage();
    await page.goto('http://127.0.0.1:3007', { waitUntil: 'domcontentloaded', timeout: 20000 });
  }
  await page.bringToFront();
  const active = await page.evaluate(async () => {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('Could not inspect Workspace state');
    const state = await response.json();
    if (!Array.isArray(state.agents)) throw new Error('Unexpected agents state');
    return state.agents.filter(agent => !['stopped', 'error'].includes(agent.status)).map(agent => ({ agentId: agent.agentId, status: agent.status }));
  });
  if (active.length) throw new Error('Existing active agents detected; launch not sent');
  report.status = 'request-in-flight';
  report.requestSentAt = new Date().toISOString();
  save();
  const result = await page.evaluate(async body => {
    const response = await fetch('/api/launch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { httpStatus: response.status, ok: response.ok, body: await response.text() };
  }, request);
  report.status = result.ok ? 'launch-request-succeeded' : 'launch-request-failed';
  report.result = result;
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ status: report.status, httpStatus: result.httpStatus, reportPath }));
} catch (error) {
  report.status = report.status === 'request-in-flight' ? 'outcome-unconfirmed' : 'preflight-failed';
  report.error = error instanceof Error ? error.message : String(error);
  report.finishedAt = new Date().toISOString();
  save();
  console.error(JSON.stringify({ status: report.status, error: report.error, reportPath }));
  process.exitCode = 1;
} finally {
  await browser?.disconnect();
}
