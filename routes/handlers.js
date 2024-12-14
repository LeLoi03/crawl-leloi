const express = require('express');

const router = express.Router(); 

const {run} = require('../service/run')

const fs = require('fs');
const csvParser = require('csv-parser');

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

    // Kiểm tra nếu người dùng nhập tay
    if (conferenceData.length === 1 && conferenceData[0].Title && conferenceData[0].Acronym) {
        console.log('Manual input received:', conferenceData);
    } else {
        console.log('File upload received:', conferenceData);
    }

    try {
        await run(conferenceData);

        // Đọc lại dữ liệu từ file CSV vừa tạo
        const path = './evaluate.csv';
        let csvData = [];
        fs.createReadStream(path)
            .pipe(csvParser())
            .on('data', (row) => {
                csvData.push(row);
            })
            .on('end', () => {
                console.log('CSV file successfully processed');
                res.send({ csvData });
            })
            .on('error', (error) => {
                console.error('Error reading CSV file:', error);
                res.status(500).send({ error: 'Error reading CSV file' });
            });
    } catch (error) {
        console.error('Error processing data:', error);
        res.status(500).send({ error: 'Error processing data' });
    }
});


router.get('/crawl', (req, res) => {
    res.render('importcfp')

});

module.exports = router;


