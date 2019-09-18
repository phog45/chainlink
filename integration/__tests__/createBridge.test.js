/* eslint-disable @typescript-eslint/no-var-requires */

const pupExpect = require('expect-puppeteer')
const PupHelper = require('../support/PupHelper.js')

describe('End to end', () => {
  let browser, page, pupHelper

  beforeAll(async () => {
    ;({ browser, page, pupHelper } = await PupHelper.launch())
  })

  afterAll(async () => {
    return browser.close()
  })

  it('creates a bridge', async () => {
    await pupHelper.signIn()

    // Add Bridge
    await pupHelper.clickLink('Bridges')
    await pupExpect(page).toMatchElement('h4', { text: 'Bridges' })
    await pupHelper.clickLink('New Bridge')
    await pupExpect(page).toFillForm('form', {
      name: 'create_test_bridge',
      url: 'http://example.com',
      minimumContractPayment: '123',
      confirmations: '5',
    })
    await pupExpect(page).toClick('button', { text: 'Create Bridge' })
    await pupExpect(page).toMatch(/success.+?bridge/i)

    // Navigate to bridge show page
    const notification = await pupHelper.waitForNotification(
      'Successfully created bridge',
    )
    const notificationLink = await notification.$('a')
    await notificationLink.click()
    const pathName = await page.evaluate(() => window.location.pathname)
    expect(pathName).toEqual('/bridges/create_test_bridge')
  })
})
