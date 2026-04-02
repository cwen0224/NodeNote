const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.error('PAGE ERROR:', error.message));
  page.on('requestfailed', request => console.error('REQUEST FAILED:', request.url(), request.failure().errorText));
  
  await page.goto('http://localhost:5175/', { waitUntil: 'networkidle0' });
  
  console.log("Mouse dragging simulation...");
  await page.mouse.move(500, 500);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(600, 600);
  await page.mouse.up({ button: 'right' });
  
  console.log("Wheel simulation...");
  // Wheel isn't directly exposed easily without CDPSession, just run JS:
  await page.evaluate(() => {
    const v = document.getElementById('viewport');
    if (v) v.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100, clientX: 500, clientY: 500 }));
  });
  
  await new Promise(r => setTimeout(r, 1000));
  
  const transform = await page.evaluate(() => {
    return document.getElementById('canvas').style.transform;
  });
  console.log('FINAL CANVAS TRANSFORM:', transform);

  await browser.close();
})();
