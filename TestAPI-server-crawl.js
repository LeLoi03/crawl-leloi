const axios = require('axios');

const sendConferenceData = async (conferenceData) => {
    console.log("Data being sent:", conferenceData);

    try {
        const response = await axios.post('http://172.188.50.15:8080/crawl_from_links', conferenceData, {
            headers: {
                'Content-Type': 'application/json',
            },
        });

        console.log("Response Data: ", response.data);
    } catch (error) {
        console.error("Error sending data:", error.response ? error.response.data : error.message);
    }
    
};

// Ví dụ dữ liệu JSON gửi đi
const sampleData = 
    [
        {
          "Title":"ACM Conference on Embedded Networked Sensor Systems",
          "Acronym":"SENSYS",
          "Link": "https://sensys.acm.org/2025/"
        },
        {
          "Title":"ACM Conference on Applications, Technologies, Architectures, and Protocols for Computer Communication",
          "Acronym":"SIGCOMM",
          "Link": "https://conferences.sigcomm.org/sigcomm/2025/",
        },
        // {
        //   "Title":"ACM Information Technology Education",
        //   "Acronym":"SIGITE"
        // },
        // {
        //   "Title":"ACM International Conference on Knowledge Discovery and Data Mining",
        //   "Acronym":"KDD"
        // }
      ];

// console.log("Data being sent:", sampleData);

sendConferenceData(sampleData);
