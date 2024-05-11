const axios = require("axios").default
const puppeteer = require("puppeteer")
const fs = require("fs")
const path = require("path")
const querystring = require("querystring")

// Save the state to a file
function saveState(filePath, state) {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8")
}

// Load the state from a file
function loadState(filePath) {
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  }
  return { lastIndex: 0 } // Default state
}

// Manual delay using setTimeout inside a Promise for asynchronous waiting
function delay(time) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  })
}

// Download using axios with stream
async function downloadWithAxios(url, outputPath) {
  try {
    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
        Accept: "*/*",
      },
    })

    const writer = fs.createWriteStream(outputPath)
    response.data.pipe(writer)

    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        console.log(`Successfully downloaded ${path.basename(outputPath)}`)
        resolve()
      })
      writer.on("error", reject)
    })
  } catch (error) {
    console.error(`Error downloading ${url}: ${error.message}`)
    return null
  }
}

// Use Puppeteer for complex and dynamic content interactions
async function downloadWithPuppeteer(browser, url, outputPath) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 926 })

  try {
    await page.goto(url, { waitUntil: "networkidle0", timeout: 0 })
    await delay(10000) // Initial wait for dynamic content

    // Check for known late-loading elements on TI pages
    if (url.includes("ti.com")) {
      try {
        await page.waitForSelector('a[href*=".pdf"]', { timeout: 20000 })
        const pdfUrl = await page.$eval(
          'a[href*=".pdf"]',
          (anchor) => anchor.href
        )

        if (pdfUrl) {
          console.log(`Direct PDF link found: ${pdfUrl}`)
          return await downloadWithAxios(pdfUrl, outputPath)
        }
      } catch (e) {
        console.log("Proceeding with page interactions and rendering.")
      }
    }

    await autoScroll(page)
    await page.pdf({ path: outputPath, format: "A4" })
    console.log(`Rendered and saved PDF to ${outputPath}`)
  } catch (error) {
    console.error(`Failed to download PDF from ${url}: `, error)
  } finally {
    await page.close()
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      var totalHeight = 0
      var distance = 100
      var timer = setInterval(() => {
        var scrollHeight = document.body.scrollHeight
        window.scrollBy(0, distance)
        totalHeight += distance

        if (totalHeight >= scrollHeight) {
          clearInterval(timer)
          resolve()
        }
      }, 100)
    })
  })
}

async function downloadDatasheets(jsonData, outputFolder) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })
  const stateFile = path.join(outputFolder, "state.json")
  const state = loadState(stateFile)

  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true })
  }

  for (let i = state.lastIndex; i < jsonData.length; i++) {
    const item = jsonData[i]
    if (!item.ManufacturerProductNumber || !item.DatasheetUrl) {
      console.log("Skipping item:", item)
      continue
    }

    const manufacturerProductNumber = item.ManufacturerProductNumber.replace(
      /\//g,
      "-"
    )
    const datasheetUrl = item.DatasheetUrl.startsWith("//")
      ? "https:" + item.DatasheetUrl
      : item.DatasheetUrl

    const datasheetName = `${manufacturerProductNumber}.pdf`
    const datasheetPath = path.join(outputFolder, datasheetName)

    console.log(`Processing ${datasheetName} from ${datasheetUrl}`)

    // Decode 'gotoUrl' if present
    if (datasheetUrl.includes("gotoUrl=")) {
      const parsedUrl = new URL(datasheetUrl)
      const gotoUrl = parsedUrl.searchParams.get("gotoUrl")
      const decodedUrl = decodeURIComponent(gotoUrl)

      console.log(`Decoded direct PDF link: ${decodedUrl}`)
      await downloadWithAxios(decodedUrl, datasheetPath)
    } else if (datasheetUrl.endsWith(".pdf")) {
      console.log(`Using axios for direct download from ${datasheetUrl}`)
      await downloadWithAxios(datasheetUrl, datasheetPath)
    } else if (datasheetUrl.includes("ti.com")) {
      console.log(
        `Using Puppeteer for complex interaction with ${datasheetUrl}`
      )
      await downloadWithPuppeteer(browser, datasheetUrl, datasheetPath)
    } else {
      console.log(`Using axios for direct download from ${datasheetUrl}`)
      await downloadWithAxios(datasheetUrl, datasheetPath)
    }

    state.lastIndex = i + 1
    saveState(stateFile, state)
  }

  await browser.close()
  console.log("All datasheets downloaded successfully.")
}

;(async () => {
  const jsonFilePath = "./reference-files/microprocessor-datasheet-0510.json"
  const jsonData = require(jsonFilePath)
  const outputFolder = "./generated-folders/microprocessor_datasheets"

  await downloadDatasheets(jsonData, outputFolder)
})()
