const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log("Launching headless browser to debug NodePlus...");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Set a standard viewport
  await page.setViewport({ width: 1280, height: 720 });

  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    console.log('PAGE LOG:', text);
    logs.push(`[${msg.type().toUpperCase()}] ${text}`);
  });
  
  page.on('pageerror', error => {
    console.error('PAGE ERROR:', error.message);
    logs.push(`[FATAL ERROR] ${error.message}\n${error.stack}`);
  });

  try {
    console.log("Navigating to http://localhost:5175/ ...");
    await page.goto('http://localhost:5175/', { waitUntil: 'networkidle0', timeout: 10000 });
    
    // Wait a bit for any initApp logic
    await new Promise(r => setTimeout(r, 2000));

    console.log("Capturing screenshot: debug_screenshot.png");
    await page.screenshot({ path: 'debug_screenshot.png' });
    
    // Check for some elements
    const diagText = await page.evaluate(() => document.getElementById('diag-status')?.innerText || "NOT FOUND");
    console.log("Current Diagnostic Status:", diagText);
    logs.push("Final Diagnostic Status: " + diagText);

    // Write all logs to a file
    fs.writeFileSync('browser_debug.log', logs.join('\n'));
    console.log("Debug info saved to browser_debug.log");

  } catch (e) {
    console.error("Puppeteer crashed or timed out:", e.message);
  } finally {
    await browser.close();
    process.exit(0);
  }
})();
