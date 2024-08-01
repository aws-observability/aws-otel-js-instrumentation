## Sample Applications

### Sample App Setup

The Sample App is an ExpressJS Server that listens on `http://localhost:8080` by default
You may change the port number from `8080` using:

```shell
export SAMPLE_APP_PORT=8082
```

#### Without Instrumentation

To startup the Express Sample App without instrumentation

```shell
npm install
node sample-app-express-server.js
```

#### With OTel Instrumentation

To startup the Express Sample App with OTel auto-instrumentation

```shell
npm install
npm install --save @opentelemetry/api
npm install --save @opentelemetry/auto-instrumentations-node
node --require '@opentelemetry/auto-instrumentations-node/register' sample-app-express-server.js
```

#### With ADOT Instrumentation

To startup the Express Sample App with local AWS Distro OTel auto-instrumentation, go to the `root` directory and run the following command to install the sample app with ADOT JS instrumentation:

```shell
./scripts/install_and_link_simple_express_app_with_instrumentation.sh
```

Then start the app in this directory with:

```shell
node --require '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register' sample-app-express-server.js
```

### Ping Sample App

```shell
curl http://localhost:8080/rolldice
curl http://localhost:8080/http
curl http://localhost:8080/aws-sdk
```
