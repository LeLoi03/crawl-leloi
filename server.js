// Importing libraries
import express from 'express';
import cors from 'cors';
import expbs from 'express-handlebars';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';

const app = express();
app.use(cors()); // Cho phép tất cả các yêu cầu

// Importing files
import routes from './routes/handlers.js'; // Đảm bảo thêm đuôi '.js' khi dùng import

// Resolve __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(bodyParser.json());

// Sending static files with Express 
app.use(express.static('public'));

// Configure Handlebars
const hbs = expbs.create({
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, 'views/mainLayout'), // change layout folder name
    partialsDir: path.join(__dirname, 'views/pieces'), // change partials folder name

    // create custom express handlebars helpers
    helpers: {
        calculation: function(value) {
            return value * 5;
        },
        list: function(value, options) {
            let out = "<ul>";
            for (let i = 0; i < value.length; i++) {
                out = out + "<li>" + options.fn(value[i]) + "</li>";
            }
            return out + "</ul>";
        },
    },
});

// Express Handlebars Configuration
app.engine('handlebars', hbs.engine);
app.set('view engine', 'handlebars');
app.use(cors());

// Configure Routes
app.use('/', routes);

// Start the server
app.listen(8080, () => {
    console.log('Server is starting at port', 8080);
});
