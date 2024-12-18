const express = require('express');

const router = express.Router(); 

const {crawlFromInput} = require('../service/crawlFromInput');
const {crawlFromCorePortal} = require('../service/crawlFromCorePortal');
const {crawlFromLinks} = require('../service/crawlFromLinks');



// Routing 
router.get('/', (req, res) => {
    res.render('index', {
        title: 'Home Page',
        name: 'Esterling Accime',
        style:  'home.css',
        age: 5,
        isDisplayName: true,
        isAgeEnabled: true,
        people: [
            {firstName: "Yehuda", lastName: "Katz"},
            {firstName: "Carl", lastName: "Lerche"},
            {firstName: "Alan", lastName: "Johnson"}
        ],

        test: '<h3>Welcome to New Orlands</h3>',
    });
});

router.post('/upload', async (req, res) => {
    const conferenceData = req.body;

    if (!conferenceData || !Array.isArray(conferenceData)) {
        return res.status(400).json({ status: 'error', message: 'Invalid input data' });
    }
    try {
        // Gọi hàm xử lý dữ liệu
        const processedData = await crawlFromInput(conferenceData);
        console.log("Processed Data: ", processedData);

        // Kiểm tra nếu request đến từ một server khác
        if (req.headers['from-server'] === 'true') {
            // Trả về JSON trực tiếp
            return res.json({ status: 'success', data: processedData });
        }

        // Nếu từ giao diện, trả về dữ liệu để hiển thị
        res.json({ processedData });
    } catch (error) {
        console.error("Error processing data:", error);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

router.post('/crawl_from_core_portal', async (req, res) => {
    // const req = req.body;
    try {
        // Gọi hàm xử lý dữ liệu
        // const processedData = await crawlFromCorePortal();
        console.log("Finished crawl from Core Portal", processedData);
        
        // Nếu từ giao diện, trả về dữ liệu để hiển thị
        res.json({ text: "Success"});
    } catch (error) {
        console.error("Error processing data:", error);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

router.post('/crawl_from_links', async (req, res) => {
    const linkData = req.body;

    if (!linkData || !Array.isArray(linkData)) {
        return res.status(400).json({ status: 'error', message: 'Invalid input data' });
    }
    try {
        // Gọi hàm xử lý dữ liệu
        const processedData = await crawlFromLinks(linkData);
        console.log("Processed Data: ", processedData);

        // Kiểm tra nếu request đến từ một server khác
        if (req.headers['from-server'] === 'true') {
            // Trả về JSON trực tiếp
            return res.json({ status: 'success', data: processedData });
            // res.json({ text: "Success"});

        }

        // Nếu từ giao diện, trả về dữ liệu để hiển thị
        res.json({ processedData });
    } catch (error) {
        console.error("Error processing data:", error);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

router.get('/crawl', (req, res) => {
    res.render('importcfp')
});

module.exports = router;


