import { GoogleGenerativeAI } from "@google/generative-ai";
import csv from 'csv-parser';
import { createReadStream } from 'fs';
import fs from 'fs';
import dotenv from 'dotenv';
import PQueue from 'p-queue';
import {chromium} from "playwright";
import { JSDOM } from "jsdom";
import axios from 'axios';
import  pdf  from 'pdf-parse';
import { Mutex } from 'async-mutex';
dotenv.config(); // Tải biến môi trường từ file .env

const queue = new PQueue({ concurrency: 5 }); // Giới hạn 5 tác vụ đồng thời
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// AIzaSyAxMJPBLzIYe0gqh52YoycpAdcZQe2Io04
const apiKey = "AIzaSyAV319MCiDorKNeNykl68MAzlIJk6YRz3g";
// const apiKey = "AIzaSyCpr1J5OYn1nmXI2IMjPPESRML52IX7GV0";
const genAI = new GoogleGenerativeAI(apiKey);

const generationConfig = {
  temperature: 0.6,
  topP: 0.7,
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
        const conferences = await getConferencesOnPage(browserContext, pageUrl, i);
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
  // return allConferences.slice(0, 10);

};

const searchConferenceLinks = async (browserContext, conference) => {
  const maxLinks = 4;
  const links = [];
  const page = await browserContext.newPage();

  let timeout; // Biến để kiểm soát timeout

  try {
    // Đặt timeout toàn bộ cho quá trình tìm kiếm
    timeout = setTimeout(() => {
      console.log(`Timeout reached. Closing page for conference: ${conference.Acronym}`);
      page.close();
    }, 15000); // 20 giây để đóng trang nếu không có hành động

    // Mở trang Google và thực hiện tìm kiếm
    const searchQuery = `${conference.Title} (${conference.Acronym}) conference 2024 or 2025`;
    const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
    // console.log(googleSearchUrl);
    await page.goto(googleSearchUrl);

    // Chờ trang tìm kiếm Google tải xong
    await page.waitForSelector("#search", { timeout: 15000 });

    const unwantedDomains = [
      "scholar.google.com",
      "translate.google.com",
      "calendar.google.com",
      "www.google.com",
      "wikicfp.com",
      "dblp.org",
      "medium.com",
      "dl.acm.org",
      "easychair.org",
      "youtube.com",
      "portal.core.edu.au",
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
      "portal.insticc.org",
      "galaxybookshop.com",
      "call4paper.com",
      "twitter.com",
      "facebook.com",
      "dl.acm.org",
      "www.researchgate.net",
      "aconf.org",
      "acm.org",
      "internationalconferencealerts.com",
      "aisuperior.com",
      "resurchify.com",
      "sigarch.org",
      "sigcse.org",
      "scimagojr.com",
      "clocate.com"
    ];

    // Lấy liên kết
    const newLinks = await page.$$eval("#search a", (elements) => {
      const allLinks = [];
      const uniqueDivLinks = new Set();

      elements.forEach((el) => {
        const href = el.href;
        if (href && href.startsWith("http")) {
          const parentDiv = el.closest("div.HiHjCd.wHYlTd");
          if (parentDiv) {
            if (!uniqueDivLinks.has(parentDiv)) {
              uniqueDivLinks.add(parentDiv);
              allLinks.push(href); // Chỉ lấy 1 thẻ a từ div này
            }
          } else {
            allLinks.push(href); // Lấy tất cả thẻ a bình thường
          }
        }
      });

      return allLinks;
    });

    newLinks.forEach((link) => {
      if (
        !links.includes(link) &&
        !unwantedDomains.some((domain) => link.includes(domain)) &&
        !/book|product/i.test(link) && // Bỏ qua nếu link chứa "book" hoặc "product"
        links.length < maxLinks
      ) {
        links.push(link);
      }
    });

  } catch (error) {
    console.error(`Error while searching for conference links: ${error.message}`);
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
      // console.error(`Error loading page: ${url} - Status code: ${response ? response.status() : 'No response'}`);
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
    // console.error(`Error during getTotalPages: ${error.message}`);
    return 1; // Trả về 1 trang nếu có lỗi xảy ra
  } finally {
    await page.close();
  }
};

// Hàm lấy dữ liệu hội nghị từ một trang của ICORE Conference Portal
const getConferencesOnPage = async (browserContext, url, i) => {
  const page = await browserContext.newPage();

  try {
    const response = await page.goto(url);

    // Kiểm tra mã trạng thái HTTP
    if (!response || response.status() >= 400) {
      // console.error(`Error loading page: ${url} - Status code: ${response ? response.status() : 'No response'}`);
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
      const title_formatted = data[i].replace(/\s*\([^)]*\)/g, '');
      conferences.push({
        Title: title_formatted,
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

//     // Duyệt qua từng `onclick` để lấy thông tin chi tiết
//     for (let j = 0; j < onclickData.length; j++) {
//       const onclick = onclickData[j];
//       const match = onclick.match(/navigate\('([^']+)'\)/);
//       if (match && match[1]) {
//         const detailUrl = new URL(match[1], url).href; // Tạo URL đầy đủ
//         console.log(`Fetching details for: ${detailUrl}`);
        
//         const detailPage = await browserContext.newPage();
//         const detailResponse = await detailPage.goto(detailUrl);

//         // Kiểm tra mã trạng thái HTTP
//         if (!detailResponse || detailResponse.status() >= 400) {
//           console.error(`Error loading detail page: ${detailUrl} - Status code: ${detailResponse ? detailResponse.status() : 'No response'}`);
//           continue; // Bỏ qua trang chi tiết nếu gặp lỗi
//         }

//         // Thu thập thông tin từ các selector `#detail > div.detail` (bỏ qua các div có class là "comment")
//         const detailElements = await detailPage.$$eval(
//           "#detail > .detail", // Chỉ lấy các div có class là "detail"
//           (divs) =>
//             divs.map((div) => {
//               const rows = div.querySelectorAll(".row");
//               const details = {};

//               rows.forEach((row) => {
//                 const text = row.innerText.trim();
//                 const [key, value] = text.split(":").map((s) => s.trim());

//                 if (key && value) {
//                   if (key === "Field Of Research") {
//                     // Chỉ lưu "Field Of Research" dưới dạng mảng nếu có nhiều giá trị
//                     if (details[key]) {
//                       details[key].push(value);
//                     } else {
//                       details[key] = [value];
//                     }
//                   } else {
//                     // Các key khác chỉ lưu một giá trị
//                     details[key] = value;
//                   }
//                 }
//               });
              
//               return details; // Trả về thông tin của từng child
//             })
//         );

//         // Gộp các phần tử chi tiết vào mỗi hội nghị
//         conferences[j].Details = detailElements;

//         await detailPage.close();
//       }
//     }

//     if (!fs.existsSync("./source_rank")) {
//       fs.mkdirSync("./source_rank");
// }
//     // Ghi dữ liệu vào file JSON
//     const outputPath = `./source_rank/page_${i}.json`;
//     fs.writeFileSync(outputPath, JSON.stringify(conferences, null, 2), "utf8");
//     console.log(`Data has been saved to ${outputPath}`);

    return conferences;
  } catch (error) {
    // console.error(`Error during getConferencesOnPage: ${error.message}`);
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

const extractTextFromPDF = async (pdfUrl) => {
  try {
    // Gửi request và nhận dữ liệu PDF dưới dạng arraybuffer
    const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });

    // Chuyển arraybuffer thành Buffer (yêu cầu của pdf-parse)
    const pdfBuffer = Buffer.from(response.data);

    // Dùng pdf-parse để trích xuất văn bản
    const pdfData = await pdf(pdfBuffer);

    // Kiểm tra số trang
    if (pdfData.numpages > 3) {
      // console.log("PDF has more than 3 pages, skipping...");
      return null; // Bỏ qua PDF dài hơn 3 trang
    }

    // Trả về văn bản đã trích xuất nếu số trang <= 3
    return pdfData.text;
  } catch (error) {
    // console.error("Error extracting text from PDF:", error);
    return null;
  }
};

const saveHTMLFromCallForPapers = async (page, conference) => {
  try {
      let foundTab = false;

      const keywords = [
        { type: 'exact', values: ["call for research papers", "call for papers", "call-for-papers",
          "call for paper", "research track"] },
        { type: 'tab', values: [
          "callforpapers", "call-for-papers", "call_for_papers",
          "call-for-paper", "call-papers", "callpapers",
          "calls/main_conference_papers", "callsresearch", "cfp",
          "tech-track", "technical-track", "technical-papers",
          "tech-papers", "conference-papers"
        ]},
        { type: 'remainTab', values: [
          "technical", "papers", "research", "author-guidelines",
          "call", "topics", "tracks", "track",
          "submissions", "submission", "author"
        ]}
      ];


      const excludeTexts = [
          "doctorial consortium", "poster", "demos", "workshop",
          "tutorials", "sponsorship", "committee"
      ];

      const clickableElements = await page.$$eval("a", (els) =>
          els.map(el => ({
              url: el.href,
              text: el.textContent.trim(),
              tag: el.tagName.toLowerCase(),
              element: el.outerHTML
          }))
      );

      const processPage = async (url) => {
        const currentOrigin = new URL(page.url()).origin;
        const targetOrigin = new URL(url).origin;

        // Bỏ qua nếu URL chuyển hướng đến domain khác
        if (currentOrigin !== targetOrigin) {
          // console.log(`Skipping cross-origin URL: ${url}`);
          return { fullText: "", fullUrl: null };
        }
        
        // Nếu URL kết thúc bằng .pdf, xử lý PDF
        if (url.endsWith(".pdf")) {
            // console.log(`Processing PDF: ${url}`);
            const pdfText = await extractTextFromPDF(url);
            if (pdfText) {
              return { fullText: pdfText, fullUrl: url };
            } else {
                // console.log(`Failed to extract text from PDF: ${url}`);
                return { fullText: "", fullUrl: null };
            }
        }
        
        // const page = await browserContext.newPage();

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });

          // Lấy nội dung từ tất cả các phần tử có chứa thuộc tính "main"
        let mainContent = await page.$$eval("*", (els) => {
            return els
            .filter(el => Array.from(el.attributes).some(attr => attr.name.toLowerCase().includes("call-for-papers", "callforpapers", "call_for_papers", "main", "body-content")))
            .map(el => el.outerHTML)
            .join("\n\n");
        });
      
        if (!mainContent) {
            mainContent = await page.content();
        }
      
        const document = cleanDOM(mainContent);
        let fullText = traverseNodes(document.body);
        fullText = removeExtraEmptyLines(fullText);
      
        return { fullText, fullUrl: url };
    };

    // Tìm kiếm theo keywords
    for (const keywordType of keywords) {
      for (const value of keywordType.values) {
        const matchedElement = clickableElements.find(el => {
            if (!el || !el.url || !el.text) return false;

            const isNotImage = !/\.(png|jpe?g)$/i.test(el.url);
            const hasExcludedText = excludeTexts.some(excluded =>
                el.text.toLowerCase().includes(excluded.toLowerCase())
            );

            let matches = false;
            if (keywordType.type === 'exact') {
                matches = el.text.toLowerCase().includes(value)
            } else if (keywordType.type === 'tab' || keywordType.type === 'remainTab') {
               matches = new RegExp(`(?<=\\W|\\d|^)${value}(?=\\W|\\d|$)`, "i").test(el.url.toLowerCase())
            }
            return matches && !hasExcludedText && isNotImage;

          });

        if (matchedElement) {
          const fullUrl = new URL(matchedElement.url, page.url()).href;
          const result = await processPage(fullUrl);
          if(result.fullText){
            foundTab = true;
            return result;
          }
        }
      }
        if (foundTab) {
          break; // If a tab is found, break out of the loop
        }
    }
  
    if(!foundTab)
      return { fullText: "", fullUrl: null };

  } catch (error) {
      // console.error("Error in saveHTMLFromCallForPapers:", error);
      return { fullText: "", fullUrl: null };
  }
};

const saveHTMLFromImportantDates = async (page) => {
  try {
    
    let foundTab = false;

    const tabs = [
      "importantdates",
      "important-dates",
      "important_dates",
      "key-dates",
      "key_dates",
      "keydates",
      "dates",
      "submission",
      "submissions"
    ];

    const clickableElements = await page.$$eval("a", (els) => {
      return els.map((el) => ({
        url: el.href,
        tag: el.tagName.toLowerCase(),
        element: el.outerHTML
      }));
    });


    for (const tab of tabs) {
      // Sử dụng regex để kiểm tra tab, cho phép các dấu và số trước và sau từ khóa
      const regex = new RegExp(`(?<=\\W|\\d|^)${tab}(?=\\W|\\d|$)`, 'i');
      const matchedElement = clickableElements.find((el) => regex.test(el.url.toLowerCase()));
         
      if (matchedElement) {
        // Tạo URL đầy đủ nếu cần thiết (trường hợp là relative URL)
        const fullUrl = new URL(matchedElement.url, page.url()).href;
        const currentOrigin = new URL(page.url()).origin;
        const targetOrigin = new URL(fullUrl).origin;
        

        // Nếu URL kết thúc bằng .pdf, xử lý PDF
        if (fullUrl.endsWith(".pdf")) {
          // console.log(`Processing PDF: ${fullUrl}`);
          const pdfText = await extractTextFromPDF(fullUrl);
          if (pdfText) {
            foundTab = true;
            return { fullText: pdfText, fullUrl };
          } else {
            // console.log(`Failed to extract text from PDF: ${fullUrl}`);
            continue; // Tiếp tục với các link khác nếu không trích xuất được văn bản
          }
        }

        // Bỏ qua nếu URL chuyển hướng đến domain khác
        if (currentOrigin !== targetOrigin) {
          // console.log(`Skipping cross-origin URL: ${fullUrl}`);
          return { fullText: "", fullUrl: null };
        }

        // Chuyển hướng tới trang của tab Call for Papers
        await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 10000 });

        const htmlContent = await page.content();
        // Xử lý nội dung HTML
        const document = cleanDOM(htmlContent);
        let fullText = traverseNodes(document.body);
        fullText = removeExtraEmptyLines(fullText);

        foundTab = true;
        return { fullText, fullUrl };
      }
    }

      // Nếu không tìm thấy tab nào phù hợp
    if (!foundTab) {
    return { fullText: "", fullUrl: null };
    }

  } catch (error) {
    // console.log("Error in saveHTMLFromImportantDates:", error);
    return { fullText: "", fullUrl: null };

  }
};

async function fetchContentWithRetry(page, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await page.content(); // Lấy nội dung trang
    } catch (err) {
      // console.log(`[Attempt ${attempt}] Error fetching page content: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await page.waitForTimeout(2000); // Đợi 1 giây trước khi thử lại
    }
  }
}

const acronymMutex = new Mutex();

const addAcronymSafely = async (set, acronymIndex) => {
  let adjustedAcronym = acronymIndex;
  await acronymMutex.runExclusive(async () => {
    // Kiểm tra xem Acronym_Index đã tồn tại trong set chưa
    while (set.has(adjustedAcronym)) {
      // Nếu đã tồn tại, thêm "_diff" vào phần cuối
      const indexPart = adjustedAcronym.split('_').pop(); // Lấy phần sau dấu "_"
      adjustedAcronym = adjustedAcronym.replace(`_${indexPart}`, `_diff_${indexPart}`);
    }
    // Thêm vào set nếu chưa tồn tại
    set.add(adjustedAcronym);
  });
  return adjustedAcronym;
};

const saveHTMLContent = async (
  browserContext,
  conference,
  links,
  allBatches,
  batch,
  batchIndexRef,
  allResponsesRef,
  numConferences,
  threshold,
  existingAcronyms,
  batchPromises
) => {
  try {
      for (let i = 0; i < links.length; i++) {
          const page = await browserContext.newPage();

          try {
              // Timeout nếu trang tải quá lâu
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Timeout")), 15000)
              );
              // Biến lưu lỗi để ghi log chi tiết
              let errorDetails = null;

              // Lấy timestamp hiện tại
              const timestamp = new Date().toISOString(); // ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)

              // Đoạn này kiểm tra trạng thái của trang khi tải
              let isRedirect = false;

              // Đăng ký sự kiện lắng nghe điều hướng trước khi gọi page.goto
              page.on('framenavigated', (frame) => {
                if (frame === page.mainFrame() && frame.url() !== links[i]) {
                  isRedirect = true; // Đánh dấu rằng trang đã điều hướng
                }
              });

              const response = await Promise.race([
                page.goto(links[i], { waitUntil: "domcontentloaded" }),
                timeoutPromise
              ]).catch((err) => {
                errorDetails = err.message; // Ghi lại lỗi timeout hoặc lỗi khác
              });

               // Kiểm tra phản hồi HTTP
              if (response && !response.ok()) {
                errorDetails = `HTTP Error ${response.status()} - ${response.statusText()}`;
              }

              if (errorDetails) {
                // Ghi log chi tiết vào file nếu gặp lỗi
                const logMessage = `[${timestamp}] Acronym: ${conference.Acronym} | Link: ${links[i]} | Error: ${errorDetails}\n`;
                await fs.promises.appendFile('./error_access_link_log.txt', logMessage, 'utf8');

                continue; // Bỏ qua liên kết này, tiếp tục với liên kết tiếp theo
              }

              if (isRedirect) {
                 try {
                    // Đợi trạng thái tải ổn định
                    await page.waitForLoadState('networkidle', { timeout: 10000 }); // Đợi thêm để chắc chắn
                  } catch (err) {
                    errorDetails = `Timeout or unstable state after redirect: ${err.message}`;
                    const logMessage = `[${new Date().toISOString()}] Acronym: ${conference.Acronym} | Link: ${links[i]} | Error: ${errorDetails}\n`;
                    await fs.promises.appendFile('./error_access_link_log.txt', logMessage, 'utf8');
                    continue;
                  }
              }

              // Kiểm tra URL hiện tại
              if (page.url() === links[i] || isRedirect) {
                 // // Sử dụng hàm thử lại
                const htmlContent = await fetchContentWithRetry(page);


                // Xử lý nội dung HTML
                const document = cleanDOM(htmlContent);
                let fullText = traverseNodes(document.body);
                fullText = removeExtraEmptyLines(fullText);

                const { fullText: cfp, fullUrl: cfpLink } = await saveHTMLFromCallForPapers(page, conference) || {}; //
                const { fullText: imp, fullUrl: impLink } = await saveHTMLFromImportantDates(page) || {}; // 
                // Kiểm tra fallback khi không tìm thấy nội dung
                const impContent = `Important Dates information:\n${imp}` || "";
                const cfpContent = ` Call for Papers information:\n${cfp}` || "";


                const acronym_index = `${conference.Acronym}_${i}`;
                // Xử lý Acronym để tránh trùng lặp
                let adjustedAcronym = await addAcronymSafely(existingAcronyms, acronym_index);
          
                 // Tổng hợp nội dung cuối cùng
                const combinedContent = `Conference ${adjustedAcronym}:\n${fullText}${impContent}${cfpContent}`; //

              
                let acronym_no_index = adjustedAcronym.substring(0, adjustedAcronym.lastIndexOf('_'));
                  // Push dữ liệu vào batch
                batch.push({
                  conferenceName: conference.Title,
                  conferenceAcronym: acronym_no_index,
                  conferenceIndex: i,
                  conferenceLink: links[i] || "No conference link available.",
                  cfpLink: cfpLink || "No CFP link found.",
                  impLink: impLink || "No IMP link found.",
                  conferenceText: combinedContent.trim(),
                });

                  if (batch.length === numConferences) {
                      const currentBatchIndex = batchIndexRef.current;
                      batchIndexRef.current++;

                      const sendBatch = [...batch]; // Tạo bản sao của batch
                      allBatches.push(sendBatch); // Thêm vào danh sách tất cả các batch
                      batch.length = 0; // Reset batch
                      console.log(`Saved batch ${currentBatchIndex} with ${numConferences} links`); // Kiểm tra batch được lưu
                      
                      // Gọi API và lưu file, thêm promise vào danh sách
                      const batchPromise = saveBatchToFile(sendBatch, currentBatchIndex, threshold)
                      batchPromises.push(batchPromise);

                      
                  }
              } else {
                 errorDetails = 'Unexpected URL after navigation.';
                  const logMessage = `[${timestamp}] Acronym: ${conference.Acronym} | Link: ${links[i]} | Error: ${errorDetails}\n`;
                  await fs.promises.appendFile('./error_access_link_log.txt', logMessage, 'utf8');
                  continue;
              }
          } catch (error) {
                // Lấy timestamp hiện tại
                const timestamp = new Date().toISOString();
                // Ghi log lỗi chi tiết vào file khi gặp lỗi không mong muốn
              const logMessage = `[${timestamp}] Acronym: ${conference.Acronym} | Link: ${links[i]} | Unexpected Error: ${error.message}\n`;
              await fs.promises.appendFile('./error_access_link_log.txt', logMessage, 'utf8');

          } finally {
               // Đóng tab nếu không có thay đổi trong 30 giây
              await page.close();
          }
      }
      return { batch, allBatches, allResponsesRef, batchPromises };
  } catch (error) {
     const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] Error in saveHTMLContent: ${error.message}\n`;
      await fs.promises.appendFile('./error_access_link_log.txt', logMessage, 'utf8');
      return { batch, allBatches, allResponsesRef, batchPromises };
  }
};

const saveBatchToFile = async (batch, batchIndex, threshold) => {
  try {
      if (!fs.existsSync("./batches")) {
          fs.mkdirSync("./batches");
      }
      const fileName = `batch_${batchIndex}.txt`;
      const filePath = `./batches/${fileName}`;

      const numConferences = batch.length;
      let fileContent = batch
        .map((entry, index) => `${index + 1}. ${entry.conferenceText}\n\n`)
        .join("");

      // Thực hiện lưu file và gọi API song song
      const fileWritePromise = fs.promises.writeFile(filePath, fileContent, "utf8")
        .then(() => console.log(`Batch ${batchIndex} saved successfully to ${filePath}`));

      const apiCallPromise = callGeminiAPI(fileContent, batchIndex, numConferences, threshold)
        .then(({ responseText, metaData }) => {
          return responseText;
      });

      // trả về 1 Promise cho việc ghi file và call API
      return Promise.all([fileWritePromise, apiCallPromise]).then(([_, responseText]) => {
        return responseText;
      })

  } catch (error) {
      console.error("Error saving batch to file:", error);
      return null; // Trả về null khi có lỗi để dễ dàng xử lý
  }
};

const logErrorToFile = async (message) => {
  const logFilePath = "./error_log.txt"; // Đường dẫn file log
  const timestamp = new Date().toISOString(); // Lấy timestamp hiện tại
  const logMessage = `[${timestamp}] ${message}\n`;
  await fs.promises.appendFile(logFilePath, logMessage, "utf8"); // Ghi thêm vào file
};

const lastRequestTimestampRef = { current: 0 };
const semaphore = new Map();

const acquireLock = async (key) => {
  while (semaphore.get(key)) {
    // Chờ cho đến khi khóa được giải phóng
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // Đặt khóa và cập nhật thời gian của yêu cầu gần nhất
  semaphore.set(key, true);
};

const releaseLock = (key) => {
  semaphore.delete(key); // Xóa khóa
};

const checkResponseCoverage = (batch, batchIndex, responseText) => { 
  // Trích xuất danh sách hội nghị từ batch
  const batchConferences = batch
    .split("\n")
    .map((line) => {
      const match = line.match(/^\d+\.\s+Conference\s+(.+):/);
      return match ? match[1] : null;
    })
    .filter(Boolean); // Lọc bỏ null

  // Trích xuất danh sách hội nghị từ response
  const responseConferences = responseText
    .split("\n")
    .map((line) => {
      const match = line.match(/^\d+\.\s+(?:Information\s+of|Conference)\s+(.+):/);
      return match ? match[1] : null;
    })
    .filter(Boolean); // Lọc bỏ null

  // Kiểm tra số lượng hội nghị khớp giữa batch và response
  const matchedConferences = batchConferences.filter((conf) =>
    responseConferences.includes(conf)
  );

  const matchRatio = matchedConferences.length / batchConferences.length;

  // Kiểm tra điều kiện số lượng khớp
  const isCountMatch = responseConferences.length === batchConferences.length;
  const isCoveragePass = matchRatio === 1.0 && isCountMatch;

  const timestamp = new Date().toISOString(); // Lấy timestamp hiện tại
  const logMessage = `[${timestamp}] ${batchIndex}. Matched ${matchedConferences.length} / ${batchConferences.length} conferences (${(matchRatio * 100).toFixed(2)}%), Count Match: ${isCountMatch}`;

  console.log(logMessage);
  // Ghi log vào file
  const logFilePath = './coverage_log.txt';
  fs.promises.appendFile(logFilePath, logMessage + '\n', 'utf8');

  return { matchRatio, isCoveragePass }; // Trả về tỷ lệ khớp và trạng thái đạt hay không
};


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

const extractLimitedConferences = (responseText, numConferences) => {
  // Regex để tách từng phần thông tin của hội nghị
  const conferenceRegex = /(\d+\.\s+(?:Information\s+of|Conference)\s+.+?:)([\s\S]*?)(?=\n\d+\.\s+(?:Information\s+of|Conference)\s+.+?:|$)/g;
  const matches = [];
  let match;
  
  // Duyệt từng phần thông tin của hội nghị
  while ((match = conferenceRegex.exec(responseText)) !== null) {
    const fullConferenceInfo = match[0].trim(); // Toàn bộ thông tin của một hội nghị
    matches.push(fullConferenceInfo);
  }

  // Giới hạn số lượng hội nghị
  const limitedConferences = matches.slice(0, numConferences);

  // Gộp lại thành văn bản
  return limitedConferences.join("\n\n");
};

const callGeminiAPI = async (batch, batchIndex, numConferences, threshold) => {
  const lockKey = "gemini_api"; // Khóa chung cho tất cả các request
  let retryCount = 0;
  const maxRetries = 6;
  const delayBetweenRetries = 15000; // 25 giây
  const minDelayBetweenRequests = 15000; // 25 giây

  let bestResponse = null;
  let bestCoverage = 0;

  while (retryCount < maxRetries) {
    try {
      // Acquire lock để đảm bảo thứ tự xử lý
      await acquireLock(lockKey);

      const currentTimestamp = Date.now();
      const timeSinceLastRequest = currentTimestamp - lastRequestTimestampRef.current;

      // Đảm bảo khoảng cách tối thiểu giữa các yêu cầu
      if (timeSinceLastRequest < minDelayBetweenRequests) {
        const waitTime = minDelayBetweenRequests - timeSinceLastRequest;
        console.log(`Waiting ${waitTime / 1000}s before next request...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      // Cập nhật dấu thời gian ngay khi gửi request
      lastRequestTimestampRef.current = Date.now();

      const parts = [
        { text: `${inputPart1}` },
        { text: `${outputPart1}` },
        { text: `${inputPart2}` },
        { text: `${outputPart2}` },
        { text: `${inputPart3}` },
        { text: `${outputPart3}` },
        { text: `${inputPart4}` },
        { text: `${outputPart4}` },
        { text: `input_${numConferences}: \n${batch}` },
        { text: `output_${numConferences}: ` },
      ];

      // RISE prompt technique
      const systemInstruction = `
      Role: You are a highly specialized conference data extraction and formatting expert. Your core responsibility is to meticulously process conference information, capturing all relevant dates, locations, formats, and topics while adhering strictly to the prescribed output format. You must extract and format all provided dates with precision, ensuring no crucial information (dates, location, formats) is omitted and no unnecessary information is included (rank, core, speakers, fee, link, hours, programme). You must avoid including labels for any data that is not available. Your output *must* directly correspond to the data provided in the input_${numConferences}, not merely replicate the examples' output.

      Instruction:
        1. Output Format Enforcement: You must strictly adhere to the specific output *structure* and *style* demonstrated in the few-shot examples, including the labels and spacing. The few-shot examples should guide your formatting. However, the actual conference *content* (conference names, dates, locations, etc.) for each conference must be extracted *solely* from the corresponding conference's data in input_${numConferences}. Do not return the output in JSON or any other format. The output must be in the exact text format shown in the examples, using data solely from input_${numConferences}.
        2. Complete and Ordered Output Requirement: You must generate a final output, labeled output_${numConferences}, containing information for all ${numConferences} conferences listed in input_${numConferences}. The conferences in output_${numConferences} must appear in the precise order they are presented in input_${numConferences}. Do not omit any conference, and do not reorder the conferences. The number of conferences, names and order in output_${numConferences} must directly match input_${numConferences} (extremely important, must ensure).
        3. Handle Missing Critical Information: If, for a given conference, *none* of the following information is present in that specific conference's data in input_${numConferences}: conference dates, location, conference format, *or* at least one event date, then output the text: "No information available" for that conference.
        4. Information Source Restriction: You must use only the specific data provided for that conference within input_${numConferences}. Do not introduce any external information or data from other conferences. You must not infer, extrapolate, or combine data from any other source.
        5. Conference Data Integrity: You must ensure that output_${numConferences} reflects the correct conference names, the correct number of conferences (${numConferences}), and the correct order of conferences. All extracted data for a conference must be *solely* from the data provided for that *specific* conference in input_${numConferences}. There must be a one to one relationship between input_${numConferences} conference data and the extracted data in output_${numConferences} for each conference.

      Situation: You are provided with a list of ${numConferences} conferences in input_${numConferences}, each potentially containing various dates, location, type (format), and topic information. Your task is to extract all the relevant details that are available and present them in a strict, formatted output, following the *structure* and *style* of the few-shot examples. You must pay strict attention to date formatting, date labeling, the output structure, and only outputting information that is present and adheres to the required format. The actual content you output must directly correspond with input_${numConferences} content for that conference. Handle cases with missing information as described above and in few-shot examples.
      `;

      // console.log(systemInstruction);

      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash-latest",
        systemInstruction: systemInstruction,
      });

      console.log(`Sended request ${batchIndex} !`)
      const response = await model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig,
      });


      const responseText = response.response.text();
      const metaData = response.response.usageMetadata;

      // Kiểm tra response coverage
      const { matchRatio, isCoveragePass } = checkResponseCoverage(batch, batchIndex, responseText);
      if (matchRatio > bestCoverage) {
        bestCoverage = matchRatio;
        bestResponse = { responseText, metaData };
      }

      if (isCoveragePass) {
        // Lưu response nếu đạt yêu cầu
        if (!fs.existsSync(`./responses`)) {
          fs.mkdirSync(`./responses`);
        }
        const response_outputPath = `./responses/result_${batchIndex}_${numConferences}.txt`;
        await fs.promises.writeFile(response_outputPath, responseText, "utf8");

        // Giải phóng khóa
        releaseLock(lockKey);

        return bestResponse; // Trả về phản hồi tốt nhất
      }


      throw new Error(`Response coverage below ${threshold}% threshold. Retrying...`);

    } catch (error) {
      // Giải phóng khóa nếu lỗi xảy ra
      releaseLock(lockKey);
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
      } else {
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

        // Nếu có phản hồi tốt nhất, lưu nó
        if (bestResponse) {
          const filteredResponseText = extractLimitedConferences(bestResponse.responseText, numConferences);


          if (!fs.existsSync(`./responses`)) {
            fs.mkdirSync(`./responses`);
          }
          const bestResponsePath = `./responses/result_${batchIndex}_${numConferences}.txt`;
          await fs.promises.writeFile(bestResponsePath, filteredResponseText, "utf8");
          const saveBestResponseMessage = `Saved best response for batch #${batchIndex} with coverage ${(bestCoverage * 100).toFixed(2)}%.`;
          await logErrorToFile(saveBestResponseMessage);
          return { ...bestResponse, responseText: filteredResponseText };
        } else {
          return { responseText: "", metaData: null };
        }

      }
    }
  }   
};

// Helper function to determine if a link is prioritized
function isPrioritizedLink(conferenceName, conferenceAcronym, conferenceLink, conferenceText) {
  if (!conferenceAcronym || !conferenceLink || !conferenceText) {
    // console.log(`[PRIORITIZED LINK] Invalid input parameters. Returning false.`);
    return false; // Ensure no undefined is returned
  }

  // Check if the acronym exists in the link
  const acronymRegex = new RegExp(`(?<=\\W|\\d|^)${conferenceAcronym}(?=\\W|\\d|$|conference)`, 'i');
  const isAcronymInLink = acronymRegex.test(conferenceLink);

  if (isAcronymInLink) {
    // console.log(`[PRIORITIZED LINK] Acronym found in link: ${conferenceLink}`);
    return true;
  }

  // Check if the conference name matches in the conference text
  const words = conferenceName.split(/\s+/); // Split conferenceName into words
  const pattern = words.map(word => `\\b${word}\\b`).join('\\d*'); // Regex with digits between words
  const nameRegex = new RegExp(pattern, 'i'); // Create regex (case insensitive)

  const nameMatch = nameRegex.test(conferenceText);
  if (nameMatch) {
    // console.log(`[PRIORITIZED LINK] Conference name matches in text: ${conferenceName}`);
    return true;
  }

  return false; // No matches found
}

function shouldUpdateMain(existingData, currentData, isAcronymInLink, isMainPriority) {
  // console.log(`[CHECK] Should update main: isAcronymInLink=${isAcronymInLink}, isMainPriority=${isMainPriority}`);

  // Nếu link mới là Priority và Main hiện tại không phải Priority, cho phép cập nhật ngay
  if (!isMainPriority && isAcronymInLink) {
    // console.log(`[PRIORITY OVERRIDE] Main is not priority, and new link is priority. Update allowed.`);
    return true;
  }

  // Nếu Main hiện tại là Priority Main và link mới không phải Priority, không được phép cập nhật
  if (isMainPriority && !isAcronymInLink) {
    // console.log(`[CHECK] Main is priority, new link is not prioritized. Update not allowed.`);
    return false;
  }

  // Nếu link mới là Priority, kiểm tra xem thông tin có tốt hơn không
  if (isAcronymInLink) {
    // console.log(`[PRIORITIZED LINK] Acronym found in link: Update allowed`);
    if (currentData.year === existingData.year) {
      return (
        currentData.numLines > existingData.numLines ||
        (currentData.numLines === existingData.numLines && currentData.nonNullFields > existingData.nonNullFields)
      );
    }
    return currentData.year >= existingData.year;
  }

  // Nếu Main hiện tại không phải Priority, áp dụng tiêu chí cập nhật thông thường
  return (
    currentData.year > existingData.year ||
    (currentData.year === existingData.year &&
      (currentData.numLines > existingData.numLines ||
        (currentData.numLines === existingData.numLines && currentData.nonNullFields > existingData.nonNullFields)))
  );
}

// Process all batches to determine main links
async function determineMainLinksWithResponses(allBatches, allResponses) {


  try {
    const conferenceMap = {};
    const responseLines = allResponses.split("\n");
    let currentKey = null;
    let currentResponse = [];

    // console.log(`[DEBUG] All batches size:`, allBatches.length);
    // console.log(`[DEBUG] All responses sample:`, responseLines.slice(0, 10));
    // console.log(`[DEBUG] allBatches:`, JSON.stringify(allBatches, null, 2));
    // console.log(`[DEBUG] allResponses:`, allResponses.slice(0, 100)); // Hiển thị 100 ký tự đầu
    

    const regex = /^\d+\.\s+(?:Information\s+of|Conference)\s+(.+):/;

    // const regex = /^\d+\.\s+Information\s+of\s+(.+):/;


    // Helper function to add or update conference map
    function addOrUpdateConferenceMap(conferenceMap, currentKey, currentResponse) {
      const filteredResponse = currentResponse.filter((line) => line.trim()); // Remove empty lines
      const currentData = {
        response: filteredResponse.join("\n"),
        numLines: filteredResponse.length,
        nonNullFields: countNonNullFields(filteredResponse),
        year: extractConferenceYear(filteredResponse),
      };
      // console.log(`Adding/Updating: ${currentKey}`, currentData);

      if (!conferenceMap[currentKey]) {
        conferenceMap[currentKey] = currentData;
        // console.log(`[NEW ENTRY] Added for ${currentKey}`);
      } else {
        const existingData = conferenceMap[currentKey];
        // console.log(`[EXISTING DATA] For ${currentKey}:`, existingData);
        if (
          currentData.year > existingData.year ||
          (currentData.year === existingData.year &&
            (currentData.numLines > existingData.numLines ||
              (currentData.numLines === existingData.numLines && currentData.nonNullFields > existingData.nonNullFields)))
        ) {
          conferenceMap[currentKey] = currentData;
          // console.log(`[UPDATED ENTRY] Updated ${currentKey} with better data`);
        } else {
          // console.log(`[NO UPDATE] ${currentKey} not updated (existing data is better)`);
        }
      }
    }


    responseLines.forEach((line) => {
      const match = line.match(regex);
      if (match) {
        if (currentKey && currentResponse.length > 0) {
          addOrUpdateConferenceMap(conferenceMap, currentKey, currentResponse);
        }
        currentKey = match[1];
        currentResponse = [];
        // console.log(`[NEW KEY DETECTED] ${currentKey}`);
      } else if (currentKey) {
        currentResponse.push(line.trim());
      }
    });

    if (currentKey && currentResponse.length > 0) {
      addOrUpdateConferenceMap(conferenceMap, currentKey, currentResponse);
    }


    const finalResults = [];

    allBatches.flat().forEach((conference) => {
      const { conferenceName, conferenceAcronym, conferenceIndex, conferenceLink, conferenceText } = conference;
      const conferenceKey = `${conferenceAcronym}_${conferenceIndex}`;
      const currentMainKey = `${conferenceAcronym}_main`;

      // console.log(`[DEBUG] conferenceKey: ${conferenceKey}`);
      // console.log(`[DEBUG] conferenceMap keys:`, Object.keys(conferenceMap));


      if (conferenceMap[conferenceKey]) {
        const currentYear = conferenceMap[conferenceKey].year || 0;
        const currentNumLines = conferenceMap[conferenceKey].numLines;
        const currentNonNullFields = conferenceMap[conferenceKey].nonNullFields;

        // console.log(`[PROCESSING] ${conferenceKey}`, { currentYear, currentNumLines, currentNonNullFields });

        if (!conferenceMap[currentMainKey]) { // Initialize main if it doesn't exist
          
          // Check if the initialized main is a prioritized link
          const initializedMainPriority = isPrioritizedLink(
            conferenceName,
            conferenceAcronym,
            conferenceLink,
            conferenceText
          );

          // Initialize main if it doesn't exist
          conferenceMap[currentMainKey] = {
            ...conferenceMap[conferenceKey],
            data: conference,
            isPriority: initializedMainPriority // Lưu trạng thái isPriority
          };         


          // console.log(`[INITIALIZED MAIN] ${currentMainKey} initialized with first valid data (isPriority=${initializedMainPriority})`);

        } else { // Compare with existing main data
          const existingData = conferenceMap[currentMainKey] || {};
          const isMainPriority = existingData.isPriority || false; // Lấy trạng thái isPriority từ Main đã lưu

          const isAcronymInLink = isPrioritizedLink(
            conferenceName,
            conferenceAcronym,
            conferenceLink,
            conferenceText
          );

          if (shouldUpdateMain(
            existingData,
            { year: currentYear, numLines: currentNumLines, nonNullFields: currentNonNullFields },
            isAcronymInLink,
            isMainPriority
          )) {
            conferenceMap[currentMainKey] = { 
              ...conferenceMap[conferenceKey], 
              data: conference,
              isPriority: isAcronymInLink // Cập nhật isPriority nếu có thay đổi
            };
            // console.log(`[UPDATED MAIN] ${currentMainKey} updated with better data`);
          } else {
            // console.log(`[NO UPDATE MAIN] ${currentMainKey} not updated (existing data is better)`);
          }
        }
      }
    });


    for (const key in conferenceMap) {
      if (key.endsWith("_main")) {
        const { data, response } = conferenceMap[key];
        finalResults.push({ ...data, response });
      }
    }

    const outputFilePath = "./mainLinksWithResponses.json";
    await fs.promises.writeFile(outputFilePath, JSON.stringify(finalResults, null, 2), "utf8");
    console.log(`[OUTPUT] Final results saved to ${outputFilePath}`);

    return finalResults;

  } catch (error) {
    console.error(`[ERROR] In determining main links with responses:`, error.message);
    return [];
  }
}

function countNonNullFields(responseLines) {
  const nonNullRegex = /^[^:]+:\s+(?!null$).+/;
  const dateRegex = /^\w+\s+\d{1,2}(?:-\d{1,2})?,\s+\d{4}$/;
  const fieldsToSkip = ["Conference dates", "Location", "Type", "Topics"];
  const nullStartFields = ["Pages", "Publisher", "Core", "Rank"]; // Các từ khóa để loại bỏ

  return responseLines.filter((line) => {
    // Loại bỏ các dòng bắt đầu bằng nullStartFields
    if (nullStartFields.some((field) => line.startsWith(field))) {
      return false;
    }

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

const processDataForDisplay = (data) => {
  try {
    return data.map((row) => {
      const processedResponse = processResponse(row.response);
      return {
        Name: row.conferenceName || "",
        Acronym: row.conferenceAcronym || "",
        Link: row.conferenceLink || "",
        Information: row.response || "",
        ...processedResponse,
      };
    });
  } catch (error) {
    console.error("Error processing data for display:", error);
    return [];
  }
};

async function crawlFromLinks(linkData) {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      "--disable-notifications",
      "--disable-geolocation",
      "--disable-extensions",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--blink-settings=imagesEnabled=false",
      "--ignore-certificate-errors"

    ],
  });

  const browserContext = await browser.newContext({
    permissions: [],
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Upgrade-Insecure-Requests': '1' },
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

  const numConferences = 5;
  const threshold = 0.95;
  const existingAcronyms = new Set(); // Biến toàn cục hoặc ở cấp cao hơn

  const allBatches = [];
  const allResponsesRef = { current: "" };
  const batch = [];
  const batchIndexRef = { current: 1 };
  const batchPromises = []; // Danh sách các promise của batch


  try {
    console.log("Starting crawler...");
    // Example usag
    const allConferences = linkData;

    // Duyệt qua từng conference
    const tasks = allConferences.map((conference) =>
      queue.add(async () => {
        console.log(`Crawling data for conference: ${conference.Acronym}`);
        const links = [
          conference.Link
        ];
        if (links.length > 0) {
          const {
            batch: updatedBatch,
            allBatches: updatedBatches,
          } = await saveHTMLContent(browserContext, conference, links, allBatches, 
            batch, batchIndexRef, allResponsesRef, numConferences, threshold, existingAcronyms, batchPromises);
          
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
        const batchPromise = saveBatchToFile(sendBatch, currentBatchIndex, threshold);
        batchPromises.push(batchPromise);

    }
    
    // Chờ tất cả các promise của batch hoàn thành
    const allBatchResponses = await Promise.allSettled(batchPromises);

    // Lọc ra các response text từ các promise đã hoàn thành
    const responseTextArray = allBatchResponses.filter(result => result.status === 'fulfilled')
        .map(result => result.value)
        .filter(response => response); // Lọc bỏ null hoặc undefined

      // Kết hợp các responseText thành một chuỗi
    allResponsesRef.current = responseTextArray.join("\n");


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
      // writeCSVFile(evaluateFilePath, mainLinksWithResponses);
      const processedData = processDataForDisplay(mainLinksWithResponses);
      return processedData;

    } else {
      console.warn("No data available to write to CSV.");
      return 0;
    }

  } catch (error) {
    console.error("Error during crawling:", error);
  } finally {
    await browser.close();
  }
}

export { crawlFromLinks };
