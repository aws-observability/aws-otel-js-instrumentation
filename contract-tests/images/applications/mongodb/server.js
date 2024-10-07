// Import necessary modules
const http = require('http');
const { MongoClient } = require('mongodb');
const process = require('process');
const url = require('url'); // For parsing URL parameters

// Constants
const PORT = 8080;
const FIND_DOCUMENT = 'find';
const INSERT_DOCUMENT = 'insert_document';
const DELETE_DOCUMENT = 'delete_document'; 
const UPDATE_DOCUMENT = 'update_document'; 
const FAULT = 'fault';

// Environment variables for database connection
const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const DB_NAME = process.env.DB_NAME;

// MongoDB connection URI
const mongoURI = `mongodb://${DB_USER}:${DB_PASS}@${DB_HOST}:27017/${DB_NAME}?authSource=admin`;

console.log("Connect to MongoDB using " + mongoURI);

// Create a new MongoClient
const client = new MongoClient(mongoURI, { useUnifiedTopology: true });

// Function to prepare the database server
async function prepareDbServer() {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log('MongoDB connection established');

    const db = client.db(DB_NAME);
    const collection = db.collection('employees');

    // Check if the collection exists
    const collections = await db.listCollections({ name: 'employees' }).toArray();
    if (collections.length === 0) {
      // Collection does not exist, create it and insert a document
      await collection.insertOne({ id: 0, name: 'to-be-updated' });
      await collection.insertOne({ id: 1, name: 'A' });
      console.log('Employee collection created and document inserted');
    } else {
      console.log('Employee collection already exists');
    }
    // Start the server after preparing the database
    startServer();
  } catch (err) {
    console.error('Error preparing database server:', err);
  }
}

// Function to start the HTTP server
function startServer() {
  const server = http.createServer((req, res) => {
    // Handle the request
    if (req.method === 'GET') {
      (async () => {
        try {
          await handleGetRequest(req, res);
        } catch (err) {
          console.error('Error in request handler:', err);
          res.statusCode = 500;
          res.end();
        }
      })();
    } else {
      res.statusCode = 405; // Method Not Allowed
      res.end();
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log('Ready');
  });
}

// Function to handle GET requests
async function handleGetRequest(req, res) {
  let statusCode = 200;
  const parsedUrl = url.parse(req.url, true); // Parse URL and query parameters
  const pathname = parsedUrl.pathname;

  try {
    const db = client.db(DB_NAME);
    const collection = db.collection('employees');

    if (pathname.includes(FIND_DOCUMENT)) {
      // Retrieve documents
      const employees = await collection.find({}).toArray();
      statusCode = 200;
      res.statusCode = statusCode;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(employees));
    } else if (pathname.includes(INSERT_DOCUMENT)) {
      // Insert a new document into the employee collection
      // Extract 'id' and 'name' from query parameters
      const id = parseInt(parsedUrl.query.id) || 2;
      const name = parsedUrl.query.name || 'B';

      await collection.insertOne({ id: id, name: name });
      console.log('New employee inserted');
      statusCode = 200;
      res.statusCode = statusCode;
      res.end();
    } else if (pathname.includes(DELETE_DOCUMENT)) {
      // Delete employee with id = 1
      await collection.deleteOne({ id: 1 });
      console.log('Employee with id=1 deleted');
      statusCode = 200;
      res.statusCode = statusCode;
      res.end();
    } else if (pathname.includes(UPDATE_DOCUMENT)) {
      // Update an existing employee entry
      const id = 0; 
      const name = 'updated_name'; 

      const result = await collection.findOneAndUpdate(
        { id: id }, // Find the employee by id
        { $set: { name: name } }, // Update the name field
        { returnOriginal: false, upsert: true } // Return the updated document, create it if it doesn't exist
      );

      if (result) {
        console.log(`Employee with id=${id} updated to name=${name}`);
        statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result.value)); // Return updated employee as response
      } else {
        console.log('Employee not found');
        statusCode = 404;
        res.statusCode = statusCode;
        res.end();
      }
    } else if (pathname.includes(FAULT)) {
      // Try to execute an invalid MongoDB command to trigger an error
      try {
        await db.command({ invalidCommand: 1 });
        statusCode = 200;
      } catch (err) {
        console.error('Expected Exception with Invalid Command occurred:', err);
        statusCode = 500;
      }
      res.statusCode = statusCode;
      res.end();
    } else {
      statusCode = 404;
      res.statusCode = statusCode;
      res.end();
    }
  } catch (err) {
    console.error('Error handling request:', err);
    statusCode = 500;
    res.statusCode = statusCode;
    res.end();
  }
}

// Start the database preparation and server
prepareDbServer();
