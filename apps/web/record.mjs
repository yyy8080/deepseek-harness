import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const DIR = '/workspace/.playwright-mcp/gif-frames-connector'
const ORIGIN = 'http://119.45.184.191'

await mkdir(DIR, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
await context.route('**', route => route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort())
const page = await context.newPage()
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)
await page.getByText('设置', { exact: true }).first().click()
await page.waitForTimeout(1500)
await page.getByText('连接器', { exact: true }).first().click()
await page.waitForTimeout(3000)
await page.getByText('测活', { exact: true }).first().click()
await page.waitForFunction(() => {
  const el = document.querySelector('[data-connector-probe-result]')
  return el !== null && (el.textContent ?? '').includes('ms')
}, undefined, { timeout: 20000 })
console.log('probe:', await page.evaluate(() => document.querySelector('[data-connector-probe-result]')?.textContent))
await page.screenshot({ path: `${DIR}/tmp-probe.png`, timeout: 15000 })
await page.getByText('用此机器对话', { exact: true }).first().click()
await page.waitForTimeout(6000)
console.log('--- after chat ---')
console.log(await page.evaluate(() => document.body.innerText.slice(0, 2500)))
console.log('url', page.url())
await page.screenshot({ path: `${DIR}/tmp-session.png`, timeout: 15000 })
await browser.close()
