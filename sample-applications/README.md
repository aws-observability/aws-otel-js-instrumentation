## Sample Applications

### Sample App Setup
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

To startup an Express Sample App with local AWS Distro OTel auto-instrumentation, first run:
```
./../scripts/2-setup-local-instrumentation-code-for-sample-app.sh
```
```
node --require '@aws-observability/aws-otel-js-instrumentation/register' sample-app-express-server.js
```
### Ping Sample App
```
curl http://localhost:8080/rolldice
curl http://localhost:8080/http
curl http://localhost:8080/aws-sdk
```
