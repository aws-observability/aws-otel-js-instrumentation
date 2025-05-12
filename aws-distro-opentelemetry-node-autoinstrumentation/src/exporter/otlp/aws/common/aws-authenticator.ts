// import { diag } from '@opentelemetry/api';
// import { getNodeVersion } from '../../../../utils';

// let SignatureV4: any;
// let HttpRequest: any;
// let defaultProvider: any;
// let Sha256: any;

// const nodeVersionSupported = getNodeVersion() >= 16;

// if (nodeVersionSupported) {
//   try {
//     const { defaultProvider: awsDefaultProvider } = require('@aws-sdk/credential-provider-node');
//     const { Sha256: awsSha256 } = require('@aws-crypto/sha256-js');
//     const { SignatureV4: awsSignatureV4 } = require('@smithy/signature-v4');
//     const { HttpRequest: awsHttpRequest } = require('@smithy/protocol-http');
    
//     // Assign to module-level variables
//     defaultProvider = awsDefaultProvider;
//     Sha256 = awsSha256;
//     SignatureV4 = awsSignatureV4;
//     HttpRequest = awsHttpRequest;
//   } catch (error) {
//     diag.error(`Failed to load required AWS dependency for SigV4 Signing: ${error}`);
//   }
// }

// export class AwsAuthenticator {

//     private static readonly SERVICE_NAME: string = 'xray';
//     private endpoint: string;
//     private region: string;
//     private service: string;

//     // Holds the dependencies needed to sign the SigV4 headers
//     private defaultProvider: any;
//     private sha256: any;
//     private signatureV4: any;
//     private httpRequest: any;

//     constructor(endpoint: string, region: string, service: string) {
//         this.endpoint = endpoint;
//         this.region = region;
//         this.service = service;
    
//     }

//         //   if (oldHeaders) {
//         //     const request = new this.httpRequest({
//         //       method: 'POST',
//         //       protocol: 'https',
//         //       hostname: url.hostname,
//         //       path: url.pathname,
//         //       body: serializedSpans,
//         //       headers: {
//         //         ...this.removeSigV4Headers(oldHeaders),
//         //         host: url.hostname,
//         //       },
//         //     });
    
//         //     try {
//         //       const signer = new this.signatureV4({
//         //         credentials: this.defaultProvider(),
//         //         region: this.region,
//         //         service: OTLPAwsSpanExporter.SERVICE_NAME,
//         //         sha256: this.sha256,
//         //       });
    
//         //       const signedRequest = await signer.sign(request);
    
//         //       // See type: https://github.com/open-telemetry/opentelemetry-js/blob/experimental/v0.57.1/experimental/packages/otlp-exporter-base/src/transport/http-transport-types.ts#L31
//         //       const newHeaders: () => Record<string, string> = () => signedRequest.headers;
//         //       this['_delegate']._transport._transport._parameters.headers = newHeaders;
//         //     } catch (exception) {
//         //       diag.debug(
//         //         `Failed to sign/authenticate the given exported Span request to OTLP XRay endpoint with error: ${exception}`
//         //       );
//         //     }
//         //   }
// }