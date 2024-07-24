var http = require('http');
var express = require('express');
const { S3Client, ListObjectsCommand } = require("@aws-sdk/client-s3");

const PORT = parseInt(process.env.SAMPLE_APP_PORT || '8080');

const app = express();

async function getRandomNumber(min, max) {
    return Math.floor(Math.random() * (max - min) + min);
}

app.get('/rolldice', (req, res) => {
    getRandomNumber(1, 6).then((val) => {
        res.send(`rolldice: ${val.toString()}`);
    })
});

app.get('/http', (req, res) => {
  const options = {
    hostname: 'www.randomnumberapi.com',
    port: 80,
    path: '/api/v1.0/random',
    method: 'GET',
  }

  var req = http.request(options, (rs) => {
    rs.setEncoding('utf8');
    rs.on('data', (result) => {
      res.send(`random value from http request: ${result}`)
    });
    rs.on('error', console.log);
  })
  req.end()
});

app.get('/aws-sdk-s3', async (req, res) => {
  const s3Client = new S3Client({region: 'us-east-1'});
  const bucketName = `test-bucket-not-exist-or-accessible`;
  try {
    await s3Client.send(
      new ListObjectsCommand({
        Bucket: bucketName
      })
    ).then((data) => {
      console.log(data);
    })
  } catch(e) {
    if (e instanceof Error) {
      console.error("Exception thrown: ", e.message);
    }
  } finally {
    res.send(`done aws sdk s3 request`);
  }
});


app.listen(PORT, () => {
    console.log(`Listening for requests on http://localhost:${PORT}`);
});