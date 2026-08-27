import { chromium } from 'playwright'

const DIR = '/workspace/.playwright-mcp/gif-frames-connector'
const ORIGIN = 'http://119.45.184.191'

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
await context.route('**', route => route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort())
const page = await context.newPage()
const shot = (name) => page.screenshot({ path: `${DIR}/${name}.png`, timeout: 20000 })

await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)
await page.getByText('设置', { exact: true }).first().click()
await page.waitForTimeout(1500)
await page.getByText('连接器', { exact: true }).first().click()
await page.waitForSelector('text=build-box', { timeout: 20000 })
await page.waitForTimeout(1500)
await shot('00-connectors')

// The probe: click and capture the settled measurement.
await page.getByText('测活', { exact: true }).first().click()
await page.waitForFunction(() => {
  const el = document.querySelector('[data-connector-probe-result]')
  return el !== null && (el.textContent ?? '').includes('ms')
}, undefined, { timeout: 20000 })
console.log('probe:', await page.evaluate(() => document.querySelector('[data-connector-probe-result]')?.textContent))
await shot('01-probe-alive')

// The chat: the panel must close and the session must be the one on screen.
await page.getByText('用此机器对话', { exact: true }).first().click()
await page.waitForFunction(() => document.querySelector('[data-settings-section="connectors"]') === null, undefined, { timeout: 20000 })
await page.waitForTimeout(2500)
await shot('02-session-open')
console.log('--- session view ---')
console.log(await page.evaluate(() => document.body.innerText.slice(0, 1200)))
await browser.close()
