'use strict';

const http = require('http');
const express = require('express');
const bunyan = require('bunyan');
const { S3Client, ListObjectsCommand } = require('@aws-sdk/client-s3');

const PORT = parseInt(process.env.SAMPLE_APP_PORT || '8080', 10);

const app = express();

// Uses bunyan logger
const logger = bunyan.createLogger({name: 'express-app', level: 'info'});

async function getRandomNumber(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

// Generate logs in your endpoints
app.get('/rolldice', (req, res) => {

  getRandomNumber(1, 6).then((val) => {
    const msg = `rolldice: ${val.toString()}`
    logger.info(msg);
    res.send(msg);
  });
});

app.get('/http', (req, res) => {
  const options = {
    hostname: 'www.randomnumberapi.com',
    port: 80,
    path: '/api/v1.0/random',
    method: 'GET',
  };

  const httpRequest = http.request(options, (rs) => {
    rs.setEncoding('utf8');
    rs.on('data', (result) => {
      const msg = `random value from http request: ${result}`
      logger.info(msg);
      res.send(msg);
    });
    rs.on('error', console.log);
  });
  httpRequest.end();
});

app.get('/aws-sdk-s3', async (req, res) => {
  const s3Client = new S3Client({ region: 'us-east-1' });
  const bucketName = 'test-bucket-not-exist-or-accessible';
  try {
    await s3Client.send(
      new ListObjectsCommand({
        Bucket: bucketName,
      }),
    ).then((data) => {
      logger.info(data);
    });
  } catch (e) {
    if (e instanceof Error) {
      logger.error(`Exception thrown: ${e.message}`);
    }
  } finally {
    const msg = 'done aws sdk s3 request'
    logger.info(msg);
    res.send(msg);
  }
});

app.listen(PORT, () => {
  console.log(`Listening for requests on http://localhost:${PORT}`);
});
