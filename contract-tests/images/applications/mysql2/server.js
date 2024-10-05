// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const http = require('http');
const mysql = require('mysql2/promise');

const SELECT = 'select';
const CREATE_DATABASE = 'create_database';
const DROP_TABLE = 'drop_table';
const ERROR = 'error';
const FAULT = 'fault';
const PORT = 8080;

const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const DB_NAME = process.env.DB_NAME;

const pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
});

async function prepareDbServer() {
    try {
        const connection = await pool.getConnection();

        const [results] = await connection.execute("SHOW TABLES LIKE 'employee'");

        if (results.length === 0) {
            await connection.execute("CREATE TABLE employee (id int, name varchar(255))");
            await connection.execute("INSERT INTO employee (id, name) VALUES (1, 'A')");
        }

        connection.release();
    } catch (err) {
        console.error('Error in prepareDbServer:', err);
        throw err;
    }
}

async function main() {
    try {
        await prepareDbServer();

        const server = http.createServer(async (req, res) => {
            if (req.method === 'GET') {
                let statusCode = 200;
                const url = req.url;
                let connection;

                try {
                    connection = await pool.getConnection();

                    if (url.includes(SELECT)) {
                        const [results] = await connection.execute("SELECT count(*) FROM employee");
                        statusCode = results.length === 1 ? 200 : 500;
                    } else if (url.includes(DROP_TABLE)) {
                        await connection.execute("DROP TABLE IF EXISTS test_table");
                        statusCode = 200;
                    } else if (url.includes(CREATE_DATABASE)) {
                        await connection.execute("CREATE DATABASE test_database");
                        statusCode = 200;
                    } else if (url.includes(FAULT)) {
                        try {
                            await connection.execute("SELECT DISTINCT id, name FROM invalid_table");
                            statusCode = 200;
                        } catch (err) {
                            console.error("Expected Exception with Invalid SQL occurred:", err);
                            statusCode = 500;
                        }
                    } else {
                        statusCode = 404;
                    }
                } catch (err) {
                    console.error('Error handling request:', err);
                    statusCode = 500;
                } finally {
                    if (connection) connection.release();
                }

                res.writeHead(statusCode);
                res.end();
            } else {
                res.writeHead(405); // Method Not Allowed
                res.end();
            }
        });

        server.listen(PORT, () => {
            console.log('Ready');
        });

    } catch (err) {
        console.error('Error in main:', err);
    }
}

main();
