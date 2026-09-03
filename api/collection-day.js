import { kv } from '@vercel/kv'
import chromium from '@sparticuz/chromium'
import puppeteer from 'puppeteer-core'

export const config = { maxDuration: 60 }

const TARGET_URL = 'https://sevenoaks-dc-host01.oncreate.app/w/webpage/waste-collection-day'
const HEADING_TEXT = 'Fortnightly garden waste collection'
const POSTCODE = 'TN13 3AB'
const ADDRESS = '17 The Drive'
const KV_KEY = 'waste-collection:next-day'
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

class StepError extends Error {
  constructor(step, message) {
    super(message)
    this.step = step
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildAddressRegexSource(address) {
  const words = address.trim().split(/\s+/).filter(Boolean).map(escapeRegExp)
  return `\\b${words.join('\\s+')}\\b`
}

// Today's date in the UK, as YYYY-MM-DD (so it lines up with the council's own day boundary
// regardless of which region the serverless function happens to run in).
function todayLondonISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())
}

// Parses the scraped "Friday 04 September 2026" format into a YYYY-MM-DD string.
function collectionDateISO(text) {
  const parts = (text || '').trim().split(/\s+/)
  if (parts.length < 4) return null
  const day = parseInt(parts[1], 10)
  const monthIndex = MONTHS.indexOf(parts[2].toLowerCase())
  const year = parseInt(parts[3], 10)
  if (Number.isNaN(day) || monthIndex === -1 || Number.isNaN(year)) return null
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isStillValid(cached) {
  if (!cached || !cached.nextCollectionDay) return false
  const iso = collectionDateISO(cached.nextCollectionDay)
  return Boolean(iso) && iso >= todayLondonISO()
}


async function launchBrowser() {
  const executablePath = await chromium.executablePath()
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  })
}

async function dismissCookieBanner(page) {
  try {
    await page.evaluate(() => {
      const pattern = /accept all|accept cookies|^accept$|i agree|allow all/i
      const buttons = Array.from(document.querySelectorAll('button, a'))
      const button = buttons.find((el) => pattern.test((el.textContent || '').trim()))
      if (button) button.click()
    })
  } catch {
    // best effort only
  }
}

async function findAndFillPostcode(page, postcode) {
  const inputHandle = await page.evaluateHandle(() => {
    const selectors = [
      'input#postcode',
      'input[name="postcode" i]',
      'input[id*="postcode" i]',
      'input[name*="postcode" i]',
      'input[placeholder*="postcode" i]',
      'input[aria-label*="postcode" i]',
    ]
    for (const selector of selectors) {
      const el = document.querySelector(selector)
      if (el) return el
    }
    const textInputs = Array.from(
      document.querySelectorAll('input[type="text"], input:not([type])'),
    ).filter((el) => el.offsetParent !== null)
    const labels = Array.from(document.querySelectorAll('label'))
    for (const label of labels) {
      if (/postcode/i.test(label.textContent || '')) {
        const forId = label.getAttribute('for')
        if (forId) {
          const el = document.getElementById(forId)
          if (el) return el
        }
        const input = label.querySelector('input')
        if (input) return input
      }
    }
    return textInputs[0] || null
  })

  const element = inputHandle.asElement()
  if (!element) return null

  await element.click({ clickCount: 3 })
  await element.type(postcode, { delay: 40 })
  return element
}

async function triggerLookup(page, inputElement) {
  const clicked = await page.evaluate(() => {
    const pattern = /find( my)? address|find postcode|search|look ?up|^find$/i
    const candidates = Array.from(
      document.querySelectorAll('button, input[type="submit"], input[type="button"], a'),
    )
    const button = candidates.find(
      (el) => pattern.test((el.textContent || el.value || '').trim()) && el.offsetParent !== null,
    )
    if (button) {
      button.click()
      return true
    }
    return false
  })

  if (!clicked) {
    await inputElement.press('Enter')
  }

  await sleep(1500)
}

async function trySelectAddress(page, addressRegexSource) {
  return page.evaluate((reSource) => {
    const re = new RegExp(reSource, 'i')

    const selects = Array.from(document.querySelectorAll('select'))
    for (const select of selects) {
      const options = Array.from(select.options || [])
      if (options.length <= 1) continue
      const match = options.find((option) => re.test(option.textContent || ''))
      if (match) {
        select.value = match.value
        select.dispatchEvent(new Event('input', { bubbles: true }))
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return { type: 'select', text: match.textContent.trim() }
      }
    }

    const candidates = Array.from(
      document.querySelectorAll('li, [role="option"], .dropdown-item, a, button, div'),
    )
    for (const el of candidates) {
      const text = (el.textContent || '').trim()
      if (!text || text.length > 200) continue
      if (!re.test(text)) continue
      const hasMatchingChild = Array.from(el.children).some((child) =>
        re.test((child.textContent || '').trim()),
      )
      if (hasMatchingChild) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      el.scrollIntoView({ block: 'center' })
      el.click()
      return { type: 'click', text }
    }

    return null
  }, addressRegexSource)
}

async function waitForHeading(page, headingText, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate(
      (heading) => document.body.innerText.includes(heading),
      headingText,
    )
    if (found) return true
    await sleep(500)
  }
  return false
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  try {
    const cached = await kv.get(KV_KEY)
    if (isStillValid(cached)) {
      res.status(200).json({ ...cached, success: true, cached: true })
      return
    }
  } catch {
    // KV not set up / unreachable — fall through and scrape live.
  }

  let browser
  let page
  const steps = []

  try {
    browser = await launchBrowser()
    page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    page.setDefaultNavigationTimeout(30000)
    page.setDefaultTimeout(20000)

    steps.push('navigate')
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 })

    steps.push('dismiss-cookies')
    await dismissCookieBanner(page)

    steps.push('find-postcode-input')
    const input = await findAndFillPostcode(page, POSTCODE)
    if (!input) {
      throw new StepError('find-postcode-input', 'Could not find a postcode input field on the page.')
    }

    steps.push('submit-postcode')
    await triggerLookup(page, input)

    steps.push('select-address')
    const addressRegexSource = buildAddressRegexSource(ADDRESS)
    let addressResult = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      addressResult = await trySelectAddress(page, addressRegexSource)
      if (addressResult) break
      await sleep(500)
    }
    if (!addressResult) {
      throw new StepError(
        'select-address',
        `Could not find "${ADDRESS}" in the address dropdown/list after entering postcode "${POSTCODE}".`,
      )
    }

    steps.push('wait-for-result')
    const found = await waitForHeading(page, HEADING_TEXT, 20000)
    if (!found) {
      throw new StepError(
        'wait-for-result',
        `The page never showed a "${HEADING_TEXT}" section after selecting the address.`,
      )
    }

    steps.push('extract-answer')
    const extracted = await page.evaluate((heading) => {
      // Find the leaf element that IS the heading (no child elements, exact text match).
      const all = Array.from(document.querySelectorAll('*'))
      const headingEl = all.find(
        (el) => el.children.length === 0 && (el.textContent || '').trim() === heading,
      )
      if (!headingEl) return { nextCollectionDay: null, cardHtml: null, cardText: null }

      // Walk up to the smallest ancestor that also contains the "next collection date" text —
      // i.e. the card for this specific collection type, not the whole page.
      let card = headingEl.parentElement
      while (card && !/next collection date/i.test(card.textContent || '')) {
        card = card.parentElement
      }
      if (!card) {
        return {
          nextCollectionDay: null,
          cardHtml: headingEl.parentElement ? headingEl.parentElement.outerHTML.slice(0, 4000) : null,
          cardText: (document.body.innerText || '').slice(0, 2000),
        }
      }

      const cardHtml = card.outerHTML.slice(0, 4000)
      const cardText = (card.innerText || '').slice(0, 2000)

      // The page renders each label/value as its own '.page_fragment' element, in order,
      // with a hidden screen-reader-only <span> sometimes sitting between them (which is
      // NOT a '.page_fragment' so it's naturally skipped here). The value fragment's own
      // 'data-current_value' attribute can be stale/wrong, so read the visible
      // '.value-as-text' span instead.
      const fragments = Array.from(card.querySelectorAll('.page_fragment'))
      const labelIndex = fragments.findIndex((el) =>
        /^your next collection date is\s*:?$/i.test((el.textContent || '').trim()),
      )

      let nextCollectionDay = null
      if (labelIndex !== -1 && fragments[labelIndex + 1]) {
        const valueFragment = fragments[labelIndex + 1]
        const valueEl = valueFragment.querySelector('.value-as-text')
        nextCollectionDay = (valueEl ? valueEl.textContent : valueFragment.textContent || '').trim()
      }

      return { nextCollectionDay, cardHtml, cardText }
    }, HEADING_TEXT)

    const responseBody = {
      success: true,
      postcode: POSTCODE,
      address: ADDRESS,
      matchedAddress: addressResult.text,
      nextCollectionDay: extracted.nextCollectionDay,
      cardText: extracted.cardText,
      cardHtml: extracted.cardHtml,
      cached: false,
    }

    if (extracted.nextCollectionDay) {
      try {
        await kv.set(KV_KEY, {
          postcode: POSTCODE,
          address: ADDRESS,
          matchedAddress: addressResult.text,
          nextCollectionDay: extracted.nextCollectionDay,
        })
      } catch {
        // KV not set up / unreachable — still return the freshly scraped result.
      }
    }

    res.status(200).json(responseBody)
  } catch (err) {
    let screenshot = null
    try {
      if (page) {
        const buf = await page.screenshot({ encoding: 'base64' })
        screenshot = `data:image/png;base64,${buf}`
      }
    } catch {
      // ignore screenshot failure
    }

    const status = err instanceof StepError ? 502 : 500
    res.status(status).json({
      success: false,
      step: err instanceof StepError ? err.step : steps[steps.length - 1] || 'unknown',
      message: err.message,
      stepsCompleted: steps,
      screenshot,
    })
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {
        // ignore close failure
      }
    }
  }
}
