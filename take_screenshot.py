import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        try:
            browser = await p.chromium.launch(
                executable_path='/usr/bin/chromium',
                headless=True,
                args=['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            )
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 800},
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            page = await context.new_page()
            print("Navigating...")
            response = await page.goto('https://www.ibm.com/es-es', wait_until='networkidle', timeout=30000)
            print("Status:", response.status if response else "No response")
            # Wait a little bit for rendering
            await asyncio.sleep(3)
            # Accept cookies if banner appears or close modal if any
            try:
                # Common trustarc / cookie banner button
                cookie_btn = await page.query_selector("button#truste-consent-button, button:has-text('Aceptar'), button:has-text('Accept')")
                if cookie_btn:
                    await cookie_btn.click()
                    await asyncio.sleep(1)
            except Exception as e:
                print("Cookie notice:", e)

            await page.screenshot(path='ibm_es.png')
            print("Screenshot saved to ibm_es.png")
            print("Title:", await page.title())
            await browser.close()
        except Exception as e:
            import traceback
            traceback.print_exc()

if __name__ == '__main__':
    asyncio.run(main())
