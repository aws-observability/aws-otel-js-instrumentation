## Sample Applications

### Sample App Setup
The Sample App is an ExpressJS Server that listens on `http://localhost:8080` by default
You may change the port number from `8080` using:
```
export SAMPLE_APP_PORT=8082
```

To startup an Express Sample App without instrumentation
```
npm install
node sample-app-express-server.js
```

To startup an Express Sample App with OTel auto-instrumentation
```
npm install
npm install --save @opentelemetry/api
npm install --save @opentelemetry/auto-instrumentations-node
node --require '@opentelemetry/auto-instrumentations-node/register' sample-app-express-server.js
```

### Ping Sample App
```
curl http://localhost:8080/rolldice
curl http://localhost:8080/http
curl http://localhost:8080/aws-sdk
```
