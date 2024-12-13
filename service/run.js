const { GoogleGenerativeAI } = require("@google/generative-ai");
const csv = require('csv-parser');
const { createReadStream } = require('fs');
const fs = require('fs');
const dotenv = require('dotenv');
const PQueue = require('p-queue-cjs').default;
const playwright = require("playwright");
const { JSDOM } = require("jsdom");
const { parse } = require("json2csv");

dotenv.config(); // Tải biến môi trường từ file .env

const queue = new PQueue({ concurrency: 5 }); // Giới hạn 5 tác vụ đồng thời
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// AIzaSyAxMJPBLzIYe0gqh52YoycpAdcZQe2Io04
const apiKey = "AIzaSyAV319MCiDorKNeNykl68MAzlIJk6YRz3g";
const genAI = new GoogleGenerativeAI(apiKey);

const systemInstruction = `
- Always return result exact format as my sample outputs provided, do not return result in json format
- Always return the final output_50 containing the information of the 50 conferences provided in input_50, without returning any extra or missing conference and ensuring the correct conferences order as provided in input_50
- When returning results for any conference in output_50, only use the information provided for that conference in input_50 to return result
- Make sure output_50 returns the correct name, total number and order of conferences as in the list provided in input_50
`

const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash-latest",
  systemInstruction: systemInstruction,
});

const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
};

const getConferenceList = async (browserContext) => {
  const baseUrl = `${process.env.PORTAL}?search=&by=${process.env.BY}&source=${process.env.CORE}&sort=aacronym&page=`;

  const totalPages = await getTotalPages(browserContext, baseUrl + "1");
  const allConferences = [];

  for (let i = 1; i <= totalPages; i++) { 
    const pageUrl = baseUrl + i;
    console.log(`${pageUrl}`);
    // Dùng hàng đợi để giới hạn số tab hoạt động
    await queue.add(async () => {
      try {
        const conferences = await getConferencesOnPage(browserContext, pageUrl);
        console.log(`Page ${i} processed successfully.`);
        allConferences.push(...conferences);
      } catch (error) {
        console.error(`Error processing page ${i}: ${error.message}`);
      }
    });
  }

  await queue.onIdle(); // Đợi hàng đợi hoàn thành
  console.log(allConferences.length)
  return allConferences;
};

const searchConferenceLinks = async (browserContext, conference) => {
  const maxLinks = 4;
  const links = [];
  const page = await browserContext.newPage();

  let timeout; // Biến để kiểm soát timeout

  try {
    // Đặt timeout toàn bộ cho quá trình tìm kiếm
    timeout = setTimeout(() => {
      // console.warn("Search process is taking too long. Closing the page.");
      page.close();
    }, 60000); // 60 giây

    // Truy cập Google
    await page.goto('https://www.google.com/', { waitUntil: 'load', timeout: 60000 });

    // Tìm hộp tìm kiếm và nhập từ khóa
    await page.waitForSelector("#APjFqb", { timeout: 30000 });
    await page.fill("#APjFqb", `${conference.Title} ${conference.Acronym} 2025`);
    await page.press("#APjFqb", "Enter");
    await page.waitForSelector("#search");

    const unwantedDomains = [
      "scholar.google.com",
      "translate.google.com",
      "google.com",
      "wikicfp.com",
      "dblp.org",
      "medium.com",
      "dl.acm.org",
      "easychair.org",
      "youtube.com",
      "https://portal.core.edu.au/conf-ranks/",
      "facebook.com",
      "amazon.com",
      "wikipedia.org",
      "linkedin.com",
      "springer.com",
      "proceedings.com",
      "semanticscholar.org",
      "myhuiban.com",
      "scholat.com",
      "10times.com",
      "x.com",
      "instagram.com",
      "hotcrp.com",
      "scitepress.org",
      "portal.insticc.org"
    ];

    // Lấy liên kết
    while (links.length < maxLinks) {
      const newLinks = await page.$$eval("#search a", (elements) => {
        return elements
          .map((el) => el.href)
          .filter((href) => href && href.startsWith("https://"));
      });

      newLinks.forEach((link) => {
        if (
          !links.includes(link) &&
          !unwantedDomains.some((domain) => link.includes(domain)) &&
          links.length < maxLinks
        ) {
          links.push(link);
        }
      });

      if (links.length < maxLinks) {
        await page.keyboard.press("PageDown");
        await page.waitForTimeout(2000);
      } else {
        break;
      }
    }

  } catch (error) {
    // console.error(`Error while searching for conference links: ${error.message}`);
  } finally {
    // Xóa timeout nếu trang kết thúc sớm
    if (timeout) clearTimeout(timeout);

    // Đóng trang
    await page.close();
  }

  return links.slice(0, maxLinks);
};

const cleanDOM = (htmlContent) => {
  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;

  // Loại bỏ tất cả các thẻ <script> và <style>
  const scripts = document.querySelectorAll('script');
  scripts.forEach(script => script.remove());

  const styles = document.querySelectorAll('style');
  styles.forEach(style => style.remove());

  return document;
};

const normalizeTextNode = (text) => {
  // Loại bỏ dấu xuống dòng không cần thiết giữa các từ mà không có dấu câu
  text = text.replace(/([a-zA-Z0-9]),?\n\s*([a-zA-Z0-9])/g, '$1 $2');

  // Loại bỏ dấu xuống dòng không có dấu ngắt câu phía trước (dấu chấm, dấu chấm hỏi, dấu chấm than)
  text = text.replace(/([^\.\?\!])\n\s*/g, '$1 ');

  // Chuẩn hóa khoảng trắng dư thừa
  text = text.replace(/\s+/g, ' ');

  return text.trim();
};

// Hàm xử lý bảng (table)
const processTable = (table) => {
  let tableText = '';
  const rows = table.querySelectorAll('tr');
  if (rows.length === 0) return tableText;

  rows.forEach((row, rowIndex) => {
    const cells = row.querySelectorAll('td, th');
    if (rowIndex === 0) {
      tableText += ' \n '; // Thêm dòng mới trước dòng đầu tiên
    }

    let rowText = '';
    cells.forEach((cell, index) => {
      const cellText = traverseNodes(cell).trim(); // Gọi hàm traverseNodes để duyệt qua các thẻ con trong td/th
      if (cellText) { // Chỉ xử lý khi có nội dung trong thẻ td/th
        if (index === cells.length - 1) {
          rowText += cellText; // Không thêm dấu ngăn cách cho ô cuối cùng
        } else {
          rowText += cellText + ' | '; // Thêm dấu ngăn cách giữa các ô
        }
      }
    });

    if (rowText.trim()) { // Chỉ thêm dòng nếu có nội dung
      tableText += rowText + ' \n '; // Thêm dấu xuống dòng sau mỗi hàng
    }
  });

  return tableText + ' \n '; // Ngăn cách giữa các bảng
};

// Hàm xử lý danh sách ul/ol
const processList = (list) => {
  let listText = '';
  list.querySelectorAll('li').forEach(li => {
    const liText = traverseNodes(li).trim();
    if (liText) { // Chỉ xử lý khi có nội dung trong thẻ li
      listText += liText + " \n "; 
    }
  });
  return listText + ' \n ';
};

// Hàm đệ quy để duyệt qua các phần tử và xử lý chúng
const traverseNodes = (node) => {
  let text = '';

  if (node.nodeType === 3) { // Text node
    const trimmedText = normalizeTextNode(node.textContent.trim());
    if (trimmedText) {
      text += trimmedText + ' ';
    }
  } else if (node.nodeType === 1) { // Element node
    const tagName = node.tagName.toLowerCase();

    if (tagName === 'table') {
      text += processTable(node);
    } else if (tagName === 'li') {
      const childrenText = [];

      node.childNodes.forEach(child => {
        const childText = traverseNodes(child).trim();
        if (childText) { // Chỉ xử lý khi có nội dung trong thẻ con
          childrenText.push(childText); // Lưu lại các thẻ con của <li>
        }
      });

      if (childrenText.length > 0) {
        text += childrenText.join(' | ') + ' \n '; // Ngăn cách giữa các thẻ con bằng "|"
      }
    } else if (tagName === 'br') {
      text += ' \n '; // Thêm dấu xuống dòng khi gặp thẻ <br>
    } else {
      node.childNodes.forEach(child => {
        text += traverseNodes(child); // Đệ quy xử lý các phần tử con
      });

      // Nếu là <ul> hoặc <ol>, chỉ xử lý khi không có <li> đã được xử lý
      if (tagName === 'ul' || tagName === 'ol') {
        const liElements = node.querySelectorAll('li');
        if (liElements.length === 0) {
          text += processList(node); // Xử lý danh sách nếu không có thẻ <li>
        }
      }
    }

    // Kiểm tra block-level tags và xử lý xuống dòng
    const blockLevelTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main'];

    if (!blockLevelTags.includes(tagName) && tagName !== 'table' && tagName !== 'ul' && tagName !== 'ol') {
      text += ' '; // Thêm dấu cách nếu không phải block-level hoặc bảng
    }

    if (blockLevelTags.includes(tagName) || (tagName === 'div' && node.closest('li') === null)) {
      text += ' \n '; // Xuống dòng cho các thẻ block-level
    }
  }

  return text;
};

// Hàm để loại bỏ các hàng trống liên tiếp
const removeExtraEmptyLines = (text) => {
  return text.replace(/\n\s*\n\s*\n/g, '\n\n');
};

const getTotalPages = async (browserContext, url) => {
  const page = await browserContext.newPage();

  try {
    const response = await page.goto(url);

    // Kiểm tra mã trạng thái HTTP
    if (!response || response.status() >= 400) {
      console.error(`Error loading page: ${url} - Status code: ${response ? response.status() : 'No response'}`);
      return 1; // Trả về 1 trang nếu không thể tải trang
    }

    const totalPages = await page.locator("#search > a").evaluateAll((elements) => {
      let maxPage = 1;
      elements.forEach((el) => {
        const pageValue = parseInt(el.textContent.trim(), 10);
        if (!isNaN(pageValue)) maxPage = Math.max(maxPage, pageValue);
      });
      return maxPage;
    });

    return totalPages;
  } catch (error) {
    console.error(`Error during getTotalPages: ${error.message}`);
    return 1; // Trả về 1 trang nếu có lỗi xảy ra
  } finally {
    await page.close();
  }
};

// Hàm lấy dữ liệu hội nghị từ một trang của ICORE Conference Portal
const getConferencesOnPage = async (browserContext, url) => {
  const page = await browserContext.newPage();

  try {
    const response = await page.goto(url);

    // Kiểm tra mã trạng thái HTTP
    if (!response || response.status() >= 400) {
      console.error(`Error loading page: ${url} - Status code: ${response ? response.status() : 'No response'}`);
      return []; // Trả về mảng rỗng nếu không thể tải trang
    }

    // Thu thập dữ liệu từ bảng
    const data = await page.$$eval("#search > table tr td", (tds) =>
      tds.map((td) => td.innerText)
    );

    // Thu thập các thuộc tính `onclick` từ các thẻ <tr>
    const onclickData = await page.$$eval("#search > table tr", (rows) =>
      rows
        .slice(1) // Bỏ qua thẻ <tr> đầu tiên
        .map((row) => row.getAttribute("onclick"))
        .filter((attr) => attr) // Lấy các thẻ có `onclick`
    );

    const conferences = [];
    for (let i = 0; i < data.length; i += 9) {
      conferences.push({
        Title: data[i],
        Acronym: data[i + 1],
        Source: data[i + 2],
        Rank: data[i + 3],
        Note: data[i + 4],
        DBLP: data[i + 5],
        PrimaryFoR: data[i + 6],
        Comments: data[i + 7],
        AverageRating: data[i + 8],
        Details: {}, // Sẽ thu thập thêm thông tin chi tiết
      });
    }

    // Duyệt qua từng `onclick` để lấy thông tin chi tiết
    for (let j = 0; j < onclickData.length; j++) {
      const onclick = onclickData[j];
      const match = onclick.match(/navigate\('([^']+)'\)/);
      if (match && match[1]) {
        const detailUrl = new URL(match[1], url).href; // Tạo URL đầy đủ
        console.log(`Fetching details for: ${detailUrl}`);
        
        const detailPage = await browserContext.newPage();
        const detailResponse = await detailPage.goto(detailUrl);

        // Kiểm tra mã trạng thái HTTP
        if (!detailResponse || detailResponse.status() >= 400) {
          console.error(`Error loading detail page: ${detailUrl} - Status code: ${detailResponse ? detailResponse.status() : 'No response'}`);
          continue; // Bỏ qua trang chi tiết nếu gặp lỗi
        }

        // Thu thập thông tin từ các selector `#detail > div.detail` (bỏ qua các div có class là "comment")
        const detailElements = await detailPage.$$eval(
          "#detail > .detail", // Chỉ lấy các div có class là "detail"
          (divs) =>
            divs.map((div) => {
              const rows = div.querySelectorAll(".row");
              const details = {};

              rows.forEach((row) => {
                const text = row.innerText.trim();
                const [key, value] = text.split(":").map((s) => s.trim());

                if (key && value) {
                  if (key === "Field Of Research") {
                    // Chỉ lưu "Field Of Research" dưới dạng mảng nếu có nhiều giá trị
                    if (details[key]) {
                      details[key].push(value);
                    } else {
                      details[key] = [value];
                    }
                  } else {
                    // Các key khác chỉ lưu một giá trị
                    details[key] = value;
                  }
                }
              });
              
              return details; // Trả về thông tin của từng child
            })
        );

        // Gộp các phần tử chi tiết vào mỗi hội nghị
        conferences[j].Details = detailElements;

        await detailPage.close();
      }
    }

    // Ghi dữ liệu vào file JSON
  const outputPath = "./conferences_page_data.json";
  fs.writeFileSync(outputPath, JSON.stringify(conferences, null, 2), "utf8");
  console.log(`Data has been saved to ${outputPath}`);

    return conferences;
  } catch (error) {
    console.error(`Error during getConferencesOnPage: ${error.message}`);
    return []; // Trả về mảng rỗng nếu có lỗi xảy ra
  } finally {
    await page.close();
  }
};



async function readPromptCSV(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const allInputs = [];
      const allOutputs = [];

      createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          const inputText = (row['input'] || '').trim();
          const outputText = (row['output'] || '').trim();

          if (inputText) allInputs.push(inputText);
          if (outputText) allOutputs.push(outputText);
        })
        .on('end', () => {
          // Lọc các input/output hợp lệ
          const validInputs = allInputs.filter((input) => input.trim() !== '');
          const validOutputs = allOutputs.filter((output) => output.trim() !== '');

          if (validInputs.length === 0 || validOutputs.length === 0) {
            reject(new Error('Không tìm thấy dữ liệu hợp lệ trong file CSV.'));
          }

          if (validInputs.length !== validOutputs.length) {
            reject(new Error('Số lượng input và output không khớp!'));
          }

          // Xác định số lượng phần tử mỗi phần tư
          const quarterLength = Math.ceil(validInputs.length / 4);

          // Hàm thêm số thứ tự mà không thay đổi cấu trúc của từng phần tử
          const addIndex = (array) =>
            array.length === 0
              ? [] // Nếu mảng rỗng, trả về mảng rỗng
              : array.map((item, idx) => `${idx + 1}. ${item}`); // Bắt đầu từ 1

          // Chia và thêm số thứ tự lại cho từng phần, mỗi phần reset chỉ mục
          const inputPart1 = addIndex(validInputs.slice(0, quarterLength)).join('\n');
          const inputPart2 = addIndex(validInputs.slice(quarterLength, quarterLength * 2)).join('\n');
          const inputPart3 = addIndex(validInputs.slice(quarterLength * 2, quarterLength * 3)).join('\n');
          const inputPart4 = addIndex(validInputs.slice(quarterLength * 3)).join('\n'); // Part 4

          const outputPart1 = addIndex(validOutputs.slice(0, quarterLength)).join('\n');
          const outputPart2 = addIndex(validOutputs.slice(quarterLength, quarterLength * 2)).join('\n');
          const outputPart3 = addIndex(validOutputs.slice(quarterLength * 2, quarterLength * 3)).join('\n');
          const outputPart4 = addIndex(validOutputs.slice(quarterLength * 3)).join('\n'); // Part 4


          resolve({
            inputPart1: `input: \n${inputPart1}`,
            inputPart2: `input: \n${inputPart2}`,
            inputPart3: `input: \n${inputPart3}`,
            inputPart4: `input: \n${inputPart4}`, // Part 4
            outputPart1: `output: \n${outputPart1}`,
            outputPart2: `output: \n${outputPart2}`,
            outputPart3: `output: \n${outputPart3}`,
            outputPart4: `output: \n${outputPart4}`, // Part 4
          });
        })
        .on('error', (error) => {
          reject(new Error(`Lỗi khi đọc file CSV: ${error.message}`));
        });
    } catch (error) {
      reject(new Error(`Lỗi khi xử lý file CSV: ${error.message}`));
    }
  });
}

const saveHTMLFromCallForPapers = async (page, conference, i) => {
  try {
    const tabs = [
      "cfp",
      "paper",
      "research",
      "call",
      "submission",
      "track",
      "authors"
    ];

    const clickableElements = await page.$$eval("a", (els) => {
      return els.map((el) => ({
        url: el.href,
        tag: el.tagName.toLowerCase(),
        element: el.outerHTML
      }));
    });

    // Tạo mảng để lưu các đường link Call for Papers
    const cfpLinks = [];
    let foundTab = false;

    for (const tab of tabs) {
      const matchedElement = clickableElements.find((el) => el.url.includes(tab.toLowerCase()));

      if (matchedElement) {
        // console.log(`\nFound tab '${tab}' in <${matchedElement.tag}> by URL`);

        const fullUrl = new URL(matchedElement.url, page.url()).href;

        // Chuyển hướng tới trang của tab Call for Papers
        await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

        
        // // Lấy URL của trang hiện tại sau khi nhấp vào tab Call for Papers
        // const currentURL = page.url();
        // cfpLinks.push(currentURL);  // Lưu URL vào mảng cfpLinks

        // Lưu thông tin hội nghị không tìm thấy tab
        const foundTabInfo = {
          conference: conference.Acronym,
          keyword: tab,
          htmlElement: matchedElement.tag,
          cfpUrl: matchedElement.url, 
          mainPageUrl: page.url(),
          fullUrl: fullUrl
        };

        const foundTabsFilename = './found-callforpaper-tabs.json';
        let foundTabsData = [];

        // Đọc file nếu đã tồn tại
        if (fs.existsSync(foundTabsFilename)) {
          foundTabsData = JSON.parse(fs.readFileSync(foundTabsFilename, 'utf8'));
        }

        // Thêm thông tin hội nghị mới
        foundTabsData.push(foundTabInfo);

        // Ghi lại file
        fs.writeFileSync(foundTabsFilename, JSON.stringify(foundTabsData, null, 2));
        

        // Lấy nội dung từ tất cả các phần tử có chứa thuộc tính "main"
        let mainContent = await page.$$eval("*", (els) => {
          return els
            .filter(el => Array.from(el.attributes).some(attr => attr.name.toLowerCase().includes("main")))
            .map(el => el.outerHTML)
            .join("\n\n");
        });

        if (!mainContent) {
          mainContent = await page.content();
        }

        const document = cleanDOM(mainContent);
        let fullText = traverseNodes(document.body);
        fullText = removeExtraEmptyLines(fullText);

        // try {
        //   // Lưu file txt vào thư mục "text-from-html-data-test"
        //   const outputFilePath = `./text-from-cfp-data/${conference.Acronym}_${i}.txt`;
        //   fs.promises.writeFile(outputFilePath, fullText, 'utf8');
        // } catch (error) {
        //   console.warn(`Failed to save file ${conference.Acronym}_${i}.txt: ${error.message}`);
        // }

        // try {
        //   // Tạo file json lưu đường link
        //   const linksFilename = `./cfp-link/${conference.Acronym}_${i}.json`;
        //   fs.promises.writeFile(linksFilename, JSON.stringify(cfpLinks, null, 2));
        // } catch (error) {
        //   console.warn(`Failed to save file ${conference.Acronym}_${i}.json: ${error.message}`);
        // }

      
        foundTab = true;
        return { fullText, fullUrl };
      }
    }

    // Nếu không tìm thấy tab nào phù hợp
    if (!foundTab) {
      // console.log(`\nNo 'Call for Papers' section found for ${conference.Acronym}`);
      
      // Lưu thông tin hội nghị không tìm thấy tab
      const missingTabInfo = {
        conference: conference.Acronym,
        url: page.url()
      };

      const missingTabsFilename = './missing-callforpaper-tabs.json';
      let missingTabsData = [];

      // Đọc file nếu đã tồn tại
      if (fs.existsSync(missingTabsFilename)) {
        missingTabsData = JSON.parse(fs.readFileSync(missingTabsFilename, 'utf8'));
      }

      // Thêm thông tin hội nghị mới
      missingTabsData.push(missingTabInfo);

      // Ghi lại file
      fs.writeFileSync(missingTabsFilename, JSON.stringify(missingTabsData, null, 2));
    }

    return { fullText: "", fullUrl: null };

  } catch (error) {
    // console.log("\nError in saveHTMLFromCallForPapers:", error);
    return { fullText: "", fullUrl: null }; // Trả về giá trị mặc định nếu lỗi

  }
};

const saveHTMLFromImportantDates = async (page, conference, i) => {
  try {
    const tabs = [
      "date"
    ];

    const clickableElements = await page.$$eval("a", (els) => {
      return els.map((el) => ({
        url: el.href,
        tag: el.tagName.toLowerCase(),
        element: el.outerHTML
      }));
    });

    const importantDatesLinks = [];
    let foundTab = false;

    for (const tab of tabs) {
      // Tạo biểu thức chính quy để tìm từ khóa chính xác
      const matchedElement = clickableElements.find((el) => el.url.includes(tab.toLowerCase()));

      if (matchedElement) {
        // console.log(`\nFound tab '${tab}' in <${matchedElement.tag}> by URL`);


        // Tạo URL đầy đủ nếu cần thiết (trường hợp là relative URL)
        const fullUrl = new URL(matchedElement.url, page.url()).href;

        // Chuyển hướng tới trang của tab Call for Papers
        await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30000 });


        // const currentURL = page.url(); // Đảm bảo đây là URL mới
        // importantDatesLinks.push(currentURL);

        // Lưu thông tin hội nghị tìm thấy tab
        const foundTabInfo = {
          conference: conference.Acronym,
          keyword: tab,
          htmlElement: matchedElement.tag,
          impUrl: matchedElement.url, 
          mainPageUrl: page.url(),
          fullUrl: fullUrl
        };

        const foundTabsFilename = './found-important-dates-tabs.json';
        let foundTabsData = [];

        // Đọc file nếu đã tồn tại
        if (fs.existsSync(foundTabsFilename)) {
          foundTabsData = JSON.parse(fs.readFileSync(foundTabsFilename, 'utf8'));
        }

        // Thêm thông tin hội nghị mới
        foundTabsData.push(foundTabInfo);

        // Ghi lại file
        fs.writeFileSync(foundTabsFilename, JSON.stringify(foundTabsData, null, 2));
        

        const htmlContent = await page.content();
        // Xử lý nội dung HTML
        const document = cleanDOM(htmlContent);
        let fullText = traverseNodes(document.body);
        fullText = removeExtraEmptyLines(fullText);


        // if (!fs.existsSync("./text-from-important-dates")) {
        //   fs.mkdirSync("./text-from-important-dates");
        // }

        // try {
        //   // Lưu file txt vào thư mục "text-from-html-data-test"
        //   const outputFilePath = `./text-from-important-dates/${conference.Acronym}_${i}.txt`;
        //   fs.promises.writeFile(outputFilePath, fullText, 'utf8');
        // } catch (error) {
        //   console.warn(`Failed to save file ${conference.Acronym}_${i}.txt: ${error.message}`);
        // }

        // console.log(`\nExtracted and saved Important Dates successfully: ${outputFilePath}`);

        // if (!fs.existsSync("./important-dates-link")) {
        //   fs.mkdirSync("./important-dates-link");
        // }

        // try {
        //   // Tạo file json lưu đường link
        //   const linksFilename = `./important-dates-link/${conference.Acronym}_${i}.json`;
        //   fs.promises.writeFile(linksFilename, JSON.stringify(importantDatesLinks, null, 2));
        // } catch (error) {
        //   console.warn(`Failed to save file ${conference.Acronym}_${i}.json: ${error.message}`);
        // }

        // console.log(`\nSaved Important Dates links to: ${linksFilename}`);

        foundTab = true;
        return { fullText, fullUrl };
      }
    }

      // Nếu không tìm thấy tab nào phù hợp
    if (!foundTab) {
      // console.log(`\nNo 'Important dates' section found for ${conference.Acronym}`);
      
      // Lưu thông tin hội nghị không tìm thấy tab
      const missingTabInfo = {
        conference: conference.Acronym,
        url: page.url()
      };

      const missingTabsFilename = './missing-important-dates-tabs.json';
      let missingTabsData = [];

      // Đọc file nếu đã tồn tại
      if (fs.existsSync(missingTabsFilename)) {
        missingTabsData = JSON.parse(fs.readFileSync(missingTabsFilename, 'utf8'));
      }

      // Thêm thông tin hội nghị mới
      missingTabsData.push(missingTabInfo);

      // Ghi lại file
      fs.writeFileSync(missingTabsFilename, JSON.stringify(missingTabsData, null, 2));


    }
    return { fullText: "", fullUrl: null };

      // console.log(`No 'Important Dates' section found for ${conference.Acronym}`);
    

  } catch (error) {
    // console.log("Error in saveHTMLFromImportantDates:", error);
    return { fullText: "", fullUrl: null };

  }
};

const saveHTMLContent = async (browserContext, conference, links, allBatches, batch, batchIndexRef, allResponsesRef) => {
  try {


    for (let i = 0; i < links.length; i++) {
      const page = await browserContext.newPage();


      try {
        // Timeout nếu trang tải quá lâu
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 45000)
        );

        await Promise.race([page.goto(links[i], { waitUntil: "domcontentloaded" }), timeoutPromise]);

        // Lấy nội dung HTML
        const htmlContent = await page.content();

        // Xử lý nội dung HTML
        const document = cleanDOM(htmlContent);
        let fullText = traverseNodes(document.body);
        fullText = removeExtraEmptyLines(fullText);

        const { fullText: cfp, fullUrl: cfpLink } = await saveHTMLFromCallForPapers(page, conference, i) || {};
        const { fullText: imp, fullUrl: impLink } = await saveHTMLFromImportantDates(page, conference, i) || {};

        // Kiểm tra fallback khi không tìm thấy nội dung
        const cfpContent = cfp || "No Call for Papers data found.";
        const impContent = imp || "No Important Dates data found.";

        // Tổng hợp nội dung cuối cùng
        const combinedContent = `Conference ${conference.Acronym}_${i}:\n` +
          `${fullText}\nCall for Papers data:\n${cfpContent}` +
          `\nImportant Dates data:\n${impContent}`;

        // Kiểm tra link fallback
        const conferenceLink = links[i] || "No conference link available.";

        // Push dữ liệu vào batch
        batch.push({
          conferenceName: conference.Title,
          conferenceAcronym: conference.Acronym,
          conferenceIndex: i,
          conferenceLink: conferenceLink,
          cfpLink: cfpLink || "No CFP link found.",
          impLink: impLink || "No IMP link found.",
          conferenceText: combinedContent.trim(),
        });


        // // Kiểm tra và tạo thư mục "text-from-html-data-test" nếu chưa tồn tại
        // if (!fs.existsSync("./text-from-html-data-test")) {
        //   fs.mkdirSync("./text-from-html-data-test");
        // }

        // try {
        //   // Lưu file txt vào thư mục "text-from-html-data-test"
        //   const outputFilePath = `./text-from-html-data-test/${conference.Acronym}_${i}.txt`;
        //   await fs.promises.writeFile(outputFilePath, finalContent.trim());
        // } catch (error) {
        //   console.warn(`Failed to save file ${conference.Acronym}_${i}.txt: ${error.message}`);
        // }
        


        if (batch.length === 50) {
          const currentBatchIndex = batchIndexRef.current; // Sử dụng giá trị hiện tại của batchIndex
          batchIndexRef.current++; // Sau đó mới tăng chỉ số
          
          const sendBatch = [...batch]; // Tạo bản sao của batch hiện tại
          allBatches.push(sendBatch); // Thêm vào danh sách tất cả các batch

          batch.length = 0; // Reset batch
          console.log(`Saved batch ${currentBatchIndex} with 50 links`); // Kiểm tra batch được lưu
          
          const responseText = await saveBatchToFile(sendBatch, currentBatchIndex);
          allResponsesRef.current += responseText + "\n";
        }
        
      } catch (error) {
        // console.error(`Error loading page ${links[i]}: ${error.message}`);
      } finally {
        await page.close();
      }
    }

    return { batch, allBatches, allResponsesRef };
  } catch (error) {
    // console.error("Error in saveHTMLContent:", error);
    return { batch, allBatches, allResponsesRef };
  }
};

const saveBatchToFile = async (batch, batchIndex) => {
  try {
    if (!fs.existsSync("./batches")) {
          fs.mkdirSync("./batches");
    }
    if (!fs.existsSync("./batch_token_counts")) {
      fs.mkdirSync("./batch_token_counts");
}
    const fileName = `batch_${batchIndex}.txt`;
    const filePath = `./batches/${fileName}`;

    let fileContent = batch
      .map((entry, index) => `${index + 1}. ${entry.conferenceText}\n\n`)
      .join("");

    fs.writeFileSync(filePath, fileContent, "utf8");
    console.log(`Batch ${batchIndex} saved successfully to ${filePath}`);

    const { responseText, metaData } = await callGeminiAPI(fileContent, batchIndex);

    // Ghi metaData vào file
    if (metaData) {
      const metaDataFilePath = `./batch_token_counts/token_batch_${batchIndex}.json`;
      await fs.promises.writeFile(metaDataFilePath, JSON.stringify(metaData, null, 2), "utf8");
      console.log(`MetaData for batch ${batchIndex} saved to ${metaDataFilePath}`);
    }

    return responseText;
  } catch (error) {
    console.error("Error saving batch to file:", error);
    return 0;
  }
};

const logErrorToFile = async (message) => {
  const logFilePath = "./error_log.txt"; // Đường dẫn file log
  const timestamp = new Date().toISOString(); // Lấy timestamp hiện tại
  const logMessage = `[${timestamp}] ${message}\n`;
  await fs.promises.appendFile(logFilePath, logMessage, "utf8"); // Ghi thêm vào file
};

const lastRequestTimestampRef = { current: 0 };
const requestLock = { current: false };

const callGeminiAPI = async (batch, batchIndex) => {
  let retryCount = 0;
  const maxRetries = 6; // Số lần thử lại tối đa
  const delayBetweenRetries = 65000; // Thời gian chờ giữa các lần thử (65 giây)
  const minDelayBetweenRequests = 65000; // Thời gian tối thiểu giữa các yêu cầu (65 giây)

  while (retryCount < maxRetries) {
    try {
      // Sử dụng lock để đảm bảo luồng chờ đúng thứ tự
      while (requestLock.current) {
        // console.log("Waiting for request lock...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      requestLock.current = true; // Khóa khi đang xử lý

      const currentTimestamp = Date.now();
      const timeSinceLastRequest = currentTimestamp - lastRequestTimestampRef.current;

      // Đảm bảo khoảng cách tối thiểu giữa các yêu cầu
      if (timeSinceLastRequest < minDelayBetweenRequests) {
        const waitTime = minDelayBetweenRequests - timeSinceLastRequest;
        console.log(`Waiting ${waitTime / 1000}s before next request...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      // Đọc prompt từ file CSV
      const csvPath = "./geminiapi.csv";
      const {
        inputPart1,
        inputPart2,
        inputPart3,
        inputPart4,
        outputPart1,
        outputPart2,
        outputPart3,
        outputPart4,
      } = await readPromptCSV(csvPath);

      const parts = [
        { text: `${inputPart1}` },
        { text: `${outputPart1}` },
        { text: `${inputPart2}` },
        { text: `${outputPart2}` },
        { text: `${inputPart3}` },
        { text: `${outputPart3}` },
        { text: `${inputPart4}` },
        { text: `${outputPart4}` },
        { text: `input_50: \n${batch}` },
        { text: `output_50: ` },
      ];

      const response = await model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig,
      });

      const responseText = response.response.text();
      const metaData = response.response.usageMetadata;

      lastRequestTimestampRef.current = Date.now(); // Cập nhật dấu thời gian gần nhất

      requestLock.current = false; // Mở khóa sau khi xử lý xong

      if (!fs.existsSync("./responses_50")) {
        fs.mkdirSync("./responses_50");
      }
      const response_outputPath = `./responses_50/result_${batchIndex}.txt`;
      await fs.promises.writeFile(response_outputPath, responseText, "utf8");

      return { responseText, metaData }; // Trả về cả responseText và metaData
    } catch (error) {
      requestLock.current = false; // Mở khóa trong trường hợp lỗi
      let logMessage = `Error in batch #${batchIndex}: ${error.message}`;
      if (error.message.includes("429")) {
        console.warn(`429 Error: Too Many Requests. Retrying batch #${batchIndex} in ${delayBetweenRetries / 1000}s...`);
        logMessage += ` - Retrying in ${delayBetweenRetries / 1000}s.`;
      } else if (error.message.includes("503")) {
        console.warn(`503 Error: Service Unavailable. Retrying batch #${batchIndex} in ${delayBetweenRetries / 1000}s...`);
        logMessage += ` - Retrying in ${delayBetweenRetries / 1000}s.`;
      } else if (error.message.includes("500")) {
        console.warn(`500 Error: Service temporably Unavailable. Retrying batch #${batchIndex} in ${delayBetweenRetries / 1000}s...`);
        logMessage += ` - Retrying in ${delayBetweenRetries / 1000}s.`;
      }else {
        console.error(`Error in callGeminiAPI for batch #${batchIndex}:`, error.message);
      }

      await logErrorToFile(logMessage);
      retryCount++;
      if (retryCount < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
      } else {
        const finalErrorMessage = `Failed to process batch #${batchIndex} after ${maxRetries} retries.`;
        console.error(finalErrorMessage);
        await logErrorToFile(finalErrorMessage);
        return { responseText: 0, metaData: null };
      }
    }
  }
};

async function determineMainLinksWithResponses(allBatches, allResponses) {
  try {
    const conferenceMap = {};
    const responseLines = allResponses.split("\n");
    let currentKey = null;
    let currentResponse = [];

    const regex = /^(\d+)\.\s+Information\s+of\s+(.+):/;

    responseLines.forEach((line) => {
      const match = line.match(regex);
      if (match) {
        // Trước khi chuyển sang key mới, xử lý dữ liệu hiện tại
        if (currentKey && currentResponse.length > 0) {
          addOrUpdateConferenceMap(conferenceMap, currentKey, currentResponse);
        }
        currentKey = match[2]; // Cập nhật key mới
        currentResponse = [];
      } else if (currentKey) {
        currentResponse.push(line.trim());
      }
    });

    // Xử lý dữ liệu cuối cùng sau vòng lặp
    if (currentKey && currentResponse.length > 0) {
      addOrUpdateConferenceMap(conferenceMap, currentKey, currentResponse);
    }

    const finalResults = [];
    allBatches.flat().forEach((conference) => {
      const { conferenceAcronym, conferenceIndex } = conference;
      const conferenceKey = `${conferenceAcronym}_${conferenceIndex}`;

      if (conferenceMap[conferenceKey]) {
        const currentMainKey = `${conferenceAcronym}_main`;
        const currentYear = conferenceMap[conferenceKey].year || 0;
        const currentNumLines = conferenceMap[conferenceKey].numLines;
        const currentNonNullFields = conferenceMap[conferenceKey].nonNullFields;

        if (
          !conferenceMap[currentMainKey] ||
          currentYear > conferenceMap[currentMainKey].year ||
          (currentYear === conferenceMap[currentMainKey].year &&
            (currentNumLines > conferenceMap[currentMainKey].numLines ||
              (currentNumLines === conferenceMap[currentMainKey].numLines &&
                currentNonNullFields > conferenceMap[currentMainKey].nonNullFields)))
        ) {
          conferenceMap[currentMainKey] = {
            ...conferenceMap[conferenceKey],
            data: conference,
          };
        }
      }
    });

    for (const key in conferenceMap) {
      if (key.endsWith("_main")) {
        const { data, response } = conferenceMap[key];
        finalResults.push({
          ...data,
          response,
        });
      }
    }

    const outputFilePath = "./mainLinksWithResponses.json";
    await fs.promises.writeFile(outputFilePath, JSON.stringify(finalResults, null, 2), "utf8");
    console.log(`Final results with responses have been saved to ${outputFilePath}`);

    return finalResults;
  } catch (error) {
    console.error("Error in determining main links with responses:", error.message);
    return [];
  }
}

// Hàm hỗ trợ: Thêm hoặc cập nhật vào conferenceMap
function addOrUpdateConferenceMap(conferenceMap, currentKey, currentResponse) {
  const currentData = {
    response: currentResponse.join("\n"),
    numLines: currentResponse.length,
    nonNullFields: countNonNullFields(currentResponse),
    year: extractConferenceYear(currentResponse),
  };

  if (!conferenceMap[currentKey]) {
    // Nếu chưa có, thêm mới
    conferenceMap[currentKey] = currentData;
  } else {
    const existingData = conferenceMap[currentKey];
    // Nếu đã có, so sánh và giữ dữ liệu ưu tiên hơn
    if (
      currentData.year > existingData.year ||
      (currentData.year === existingData.year &&
        (currentData.numLines > existingData.numLines ||
          (currentData.numLines === existingData.numLines &&
            currentData.nonNullFields > existingData.nonNullFields)))
    ) {
      conferenceMap[currentKey] = currentData;
    }
  }
}

// Hàm đếm số giá trị không null
function countNonNullFields(responseLines) {
  const nonNullRegex = /^[^:]+:\s+(?!null$).+/;
  const dateRegex = /^\w+\s+\d{1,2}(?:-\d{1,2})?,\s+\d{4}$/;
  const fieldsToSkip = ["Conference dates", "Location", "Type", "Topics"];

  return responseLines.filter((line) => {
    if (!nonNullRegex.test(line)) {
      return false;
    }

    const [field, value] = line.split(":").map((s) => s.trim());
    if (!field || !value) {
      return false;
    }

    if (fieldsToSkip.includes(field)) {
      return true;
    }

    return dateRegex.test(value);
  }).length;
}

// Hàm hỗ trợ: Trích xuất năm từ Conference dates
function extractConferenceYear(responseLines) {
  const dateLine = responseLines.find((line) => line.startsWith("Conference dates:"));
  if (dateLine) {
    const match = dateLine.match(/\b\d{4}\b/); // Tìm năm (4 chữ số)
    return match ? parseInt(match[0], 10) : 0;
  }
  return 0; // Không tìm thấy năm
}

// Định nghĩa các từ khóa cho từng loại cột
const keywords = {
  "Conference dates": ["conference date", "conference dates"],
  "Location": ["location"],
  "Type": ["type"],
  "Topics": ["topics"],
  "Notification date": ["notification", "review", "released", "acceptance"],
  "Camera-ready date": ["camera", "ready"],
  "Registration date": ["registration", "early", "bird"],
  "Submission date": ["paper", "abstract", "manuscript", "submission", "due", "final", "revision"]
};

// Hàm kiểm tra và phân loại từng dòng
function classifyLine(line) {
  for (const [col, kwList] of Object.entries(keywords)) {
    for (const kw of kwList) {
      if (line.toLowerCase().includes(kw)) {
        return col;
      }
    }
  }
  return "Others";
}

// Hàm lấy phần sau dấu ":"
function extractAfterColon(line) {
  const match = line.match(/:\s*(.+)/);
  return match ? match[1].trim() : line;
}

// Hàm xử lý dữ liệu "response"
function processResponse(response) {
  const result = {
    "Conference dates": [],
    "Location": [],
    "Type": [],
    "Submission date": [],
    "Notification date": [],
    "Camera-ready date": [],
    "Registration date": [],
    "Topics": [],
    "Others": []
  };

  if (!response) return result;

  response.split("\n").forEach((line) => {
    line = line.trim();
    if (!line) return;

    const category = classifyLine(line);

    // Lấy phần sau dấu ":" chỉ với cột "Conference dates" và "Location"
    if (["Conference dates", "Location", "Type", "Topics"].includes(category)) {
      line = extractAfterColon(line);
    }

    result[category].push(line);
  });

  // Chuyển danh sách các giá trị thành chuỗi
  for (const key in result) {
    result[key] = result[key].join("\n");
  }

  return result;
}

// Hàm ghi dữ liệu vào file CSV
const writeCSVFile = (filePath, data) => {
  try {
    const processedData = data.map((row) => {
      const processedResponse = processResponse(row.response);
      return {
        Name: row.conferenceName || "",
        Acronym: row.conferenceAcronym || "",
        Link: row.conferenceLink || "",
        Information: row.response || "",
        ...processedResponse
      };
    });

    // Định nghĩa các cột mới
    const fields = [
      "Name",
      "Acronym",
      "Link",
      "Information",
      "Conference dates",
      "Location",
      "Type",
      "Submission date",
      "Notification date",
      "Camera-ready date",
      "Registration date",
      "Topics",
      "Others"
    ];

    const csv = parse(processedData, { fields });
    fs.writeFileSync(filePath, csv, "utf8");
    console.log(`CSV file saved to: ${filePath}`);
  } catch (error) {
    console.error("Error writing CSV file:", error);
  }
};

// Load conference data from JSON file
function loadConferenceData(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading conference data file:', error);
    return [];
  }
}

const run = async (conferenceData) => {
  const browser = await playwright.chromium.launch({
    executablePath: EDGE_PATH,
    headless: false,
    args: [
      "--disable-notifications",
      "--disable-geolocation",
      "--disable-extensions",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--blink-settings=imagesEnabled=false",
    ],
  });

  const browserContext = await browser.newContext({
    permissions: [],
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  });

  // Tắt các tài nguyên không cần thiết tại cấp độ context
  await browserContext.route("**/*", (route) => {
    const request = route.request();
    const resourceType = request.resourceType();

    if (
      ["image", "media", "font", "stylesheet"].includes(resourceType) ||
      request.url().includes("google-analytics") ||
      request.url().includes("ads") ||
      request.url().includes("tracking")
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });


  const allBatches = [];
  const allResponsesRef = { current: "" };
  const batch = [];
  const batchIndexRef = { current: 1 };

  try {
    console.log("Starting crawler...");
    // Example usag
    const allConferences = conferenceData

    // Duyệt qua từng conference
    const tasks = allConferences.map((conference) =>
      queue.add(async () => {
        console.log(`Crawling data for conference: ${conference.Acronym}`);
        const links = await searchConferenceLinks(browserContext, conference);

        if (links.length > 0) {
          const { batch: updatedBatch, allBatches: updatedBatches } =
            await saveHTMLContent(browserContext, conference, links, allBatches, batch, batchIndexRef, allResponsesRef);

          batch.length = updatedBatch.length;
          allBatches.splice(0, allBatches.length, ...updatedBatches);
        } else {
          console.warn(`No valid links found for conference: ${conference.Acronym}`);
        }
      })
    );

    await Promise.all(tasks);

    // Xử lý batch cuối cùng
    if (batch.length > 0) {
      const currentBatchIndex = batchIndexRef.current++;
      const sendBatch = [...batch]; // Tạo bản sao batch
      allBatches.push(sendBatch); // Thêm vào danh sách tất cả các batch
      const responseText = await saveBatchToFile(sendBatch, currentBatchIndex);
      allResponsesRef.current += responseText + "\n";
    }
    

    console.log("Crawler finished.");

    const allBatchesFilePath = `./allBatches.json`;
    const allResponsesFilePath = `./allResponses.txt`;
    const evaluateFilePath = './evaluate.csv';

    // Ghi allBatches vào file JSON
    await fs.promises.writeFile(
      allBatchesFilePath,
      JSON.stringify(allBatches, null, 2), // Format JSON đẹp
      "utf8"
    );    

    if (allResponsesRef.current.trim().length > 0) { // Kiểm tra nếu allResponses không rỗng
      await fs.promises.writeFile(allResponsesFilePath, allResponsesRef.current, "utf8");
      console.log("All responses successfully saved to file.");
    } else {
      console.warn("No responses were collected to save.");
    }
    
    console.log("Determining main link of all conferences ...");
    const mainLinksWithResponses = await determineMainLinksWithResponses(allBatches, allResponsesRef.current);


    // Kiểm tra dữ liệu và xuất ra file CSV
    if (mainLinksWithResponses && mainLinksWithResponses.length > 0) {
      writeCSVFile(evaluateFilePath, mainLinksWithResponses);
    } else {
      console.warn("No data available to write to CSV.");
    }

    console.log("All works finished.")



  } catch (error) {
    console.error("Error during crawling:", error);
  } finally {
    await browser.close();
  }
};




// Chạy hàm với dữ liệu giả lập
// (async () => {
//   const allBatches = JSON.parse(fs.readFileSync("./allBatches.json", "utf8"));
//   const allResponses = fs.readFileSync("./allResponses.txt", "utf8");
//   console.log("Determining main link of all conferences ...");
//   const mainLinksWithResponses = await determineMainLinksWithResponses(allBatches, allResponses);

//   const evaluateFilePath = './evaluate_test_determine.csv';
//   // Kiểm tra dữ liệu và xuất ra file CSV
//   if (mainLinksWithResponses && mainLinksWithResponses.length > 0) {
//     writeCSVFile(evaluateFilePath, mainLinksWithResponses);
//   } else {
//     console.warn("No data available to write to CSV.");
//   }

//   console.log("All works finished.")
// })();

module.exports = {
    run
}