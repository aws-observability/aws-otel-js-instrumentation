// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import * as nock from 'nock';
import { DynamicInstrumentationClient } from '../../src/dynamic-instrumentation/client';
import { ReportStatusRequest } from '../../src/dynamic-instrumentation/model/api-response';
import {
  InstrumentationType,
  ConfigurationStatus,
  SNAPSHOT_SIGNAL_TYPE,
} from '../../src/dynamic-instrumentation/model/types';

const API_HOST = 'http://localhost:2000';
const LIST_PATH = '/list-instrumentation-configurations';
const STATUS_PATH = '/report-instrumentation-configuration-status';

describe('DynamicInstrumentationClient', function () {
  afterEach(function () {
    nock.cleanAll();
  });

  after(function () {
    nock.restore();
    nock.activate();
  });

  describe('fetchConfigurations', function () {
    it('fetches a single page and returns merged response', async function () {
      const scope = nock(API_HOST)
        .post(LIST_PATH)
        .reply(200, {
          Changed: true,
          SyncedAt: 1234,
          SyncInterval: 60,
          LatestConfigurations: [{ LocationHash: 'h1' }],
          NextToken: null,
        });

      const client = new DynamicInstrumentationClient(API_HOST);
      const res = await client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT);

      expect(res.Changed).toBe(true);
      expect(res.SyncedAt).toBe(1234);
      expect(res.SyncInterval).toBe(60);
      expect(res.LatestConfigurations).toHaveLength(1);
      expect(res.NextToken).toBeNull();
      scope.done();
    });

    it('sends Service/Environment/InstrumentationType in the request body', async function () {
      let captured: Record<string, unknown> = {};
      const scope = nock(API_HOST)
        .post(LIST_PATH, body => {
          captured = body;
          return true;
        })
        .reply(200, { Changed: false, SyncedAt: null, SyncInterval: null, LatestConfigurations: [], NextToken: null });

      const client = new DynamicInstrumentationClient(API_HOST);
      await client.fetchConfigurations('order-service', 'staging', InstrumentationType.BREAKPOINT);

      expect(captured.Service).toBe('order-service');
      expect(captured.Environment).toBe('staging');
      expect(captured.InstrumentationType).toBe(InstrumentationType.BREAKPOINT);
      scope.done();
    });

    it('sends X-Aws-K8s-Namespace and X-Aws-Deployment-Environment headers when set', async function () {
      let nsHeader: string | undefined;
      let envHeader: string | undefined;
      const scope = nock(API_HOST)
        .post(LIST_PATH)
        .reply(function () {
          nsHeader = this.req.headers['x-aws-k8s-namespace'] as string | undefined;
          envHeader = this.req.headers['x-aws-deployment-environment'] as string | undefined;
          return [
            200,
            { Changed: false, SyncedAt: null, SyncInterval: null, LatestConfigurations: [], NextToken: null },
          ];
        });

      const client = new DynamicInstrumentationClient(API_HOST, undefined, 'default', 'sample-env');
      await client.fetchConfigurations('svc', 'sample-env', InstrumentationType.BREAKPOINT);

      expect(nsHeader).toBe('default');
      expect(envHeader).toBe('sample-env');
      scope.done();
    });

    it('omits the environment headers when namespace/environment are empty', async function () {
      let nsHeader: string | undefined;
      let envHeader: string | undefined;
      const scope = nock(API_HOST)
        .post(LIST_PATH)
        .reply(function () {
          nsHeader = this.req.headers['x-aws-k8s-namespace'] as string | undefined;
          envHeader = this.req.headers['x-aws-deployment-environment'] as string | undefined;
          return [
            200,
            { Changed: false, SyncedAt: null, SyncInterval: null, LatestConfigurations: [], NextToken: null },
          ];
        });

      const client = new DynamicInstrumentationClient(API_HOST);
      await client.fetchConfigurations('svc', '', InstrumentationType.BREAKPOINT);

      expect(nsHeader).toBeUndefined();
      expect(envHeader).toBeUndefined();
      scope.done();
    });

    it('includes SyncedAt when lastSyncTime is provided', async function () {
      let captured: Record<string, unknown> = {};
      const scope = nock(API_HOST)
        .post(LIST_PATH, body => {
          captured = body;
          return true;
        })
        .reply(200, { Changed: true, SyncedAt: 1, SyncInterval: 60, LatestConfigurations: [], NextToken: null });

      const client = new DynamicInstrumentationClient(API_HOST);
      await client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT, 9999);

      expect(captured.SyncedAt).toBe(9999);
      scope.done();
    });

    it('follows pagination via NextToken and concatenates configs', async function () {
      const scope = nock(API_HOST)
        .post(LIST_PATH)
        .reply(200, {
          Changed: true,
          SyncedAt: 10,
          SyncInterval: 60,
          LatestConfigurations: [{ LocationHash: 'p1' }],
          NextToken: 'token-2',
        })
        .post(LIST_PATH)
        .reply(200, {
          Changed: true,
          SyncedAt: 20,
          SyncInterval: 60,
          LatestConfigurations: [{ LocationHash: 'p2' }],
          NextToken: null,
        });

      const client = new DynamicInstrumentationClient(API_HOST);
      const res = await client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT);

      // Metadata comes from the first page; configs are concatenated across pages
      expect(res.SyncedAt).toBe(10);
      expect(res.LatestConfigurations).toHaveLength(2);
      expect(res.LatestConfigurations[0].LocationHash).toBe('p1');
      expect(res.LatestConfigurations[1].LocationHash).toBe('p2');
      scope.done();
    });

    it('stops paginating at MAX_PAGES_PER_FETCH even if NextToken persists', async function () {
      // Reply with a non-null NextToken every time; client must stop after 3 pages.
      const scope = nock(API_HOST)
        .post(LIST_PATH)
        .times(3)
        .reply(200, {
          Changed: true,
          SyncedAt: 1,
          SyncInterval: 60,
          LatestConfigurations: [{ LocationHash: 'x' }],
          NextToken: 'always-more',
        });

      const client = new DynamicInstrumentationClient(API_HOST);
      const res = await client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT);

      expect(res.LatestConfigurations).toHaveLength(3);
      scope.done();
    });

    it('treats HTTP 404 as an empty (unchanged) response, not an error', async function () {
      const scope = nock(API_HOST).post(LIST_PATH).reply(404, 'not found');

      const client = new DynamicInstrumentationClient(API_HOST);
      const res = await client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT);

      expect(res.Changed).toBe(false);
      expect(res.LatestConfigurations).toHaveLength(0);
      scope.done();
    });

    it('rejects on a 5xx status code', async function () {
      const scope = nock(API_HOST).post(LIST_PATH).reply(500, 'boom');

      const client = new DynamicInstrumentationClient(API_HOST);
      await expect(client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT)).rejects.toThrow(
        'HTTP 500'
      );
      scope.done();
    });

    it('rejects when the response body is not valid JSON', async function () {
      const scope = nock(API_HOST).post(LIST_PATH).reply(200, 'not-json{');

      const client = new DynamicInstrumentationClient(API_HOST);
      await expect(client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT)).rejects.toThrow(
        'Failed to parse response'
      );
      scope.done();
    });

    it('rejects on a transport error', async function () {
      const scope = nock(API_HOST).post(LIST_PATH).replyWithError('socket hang up');

      const client = new DynamicInstrumentationClient(API_HOST);
      await expect(client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT)).rejects.toThrow();
      scope.done();
    });

    it('strips trailing slashes from the API URL', async function () {
      const scope = nock(API_HOST)
        .post(LIST_PATH)
        .reply(200, { Changed: false, SyncedAt: null, SyncInterval: null, LatestConfigurations: [], NextToken: null });

      const client = new DynamicInstrumentationClient(`${API_HOST}///`);
      await client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT);
      // If the trailing slashes weren't stripped, the URL would be malformed and nock wouldn't match.
      scope.done();
    });

    it('defaults missing Changed/SyncedAt/SyncInterval fields', async function () {
      const scope = nock(API_HOST)
        .post(LIST_PATH)
        .reply(200, { LatestConfigurations: [{ LocationHash: 'h' }] });

      const client = new DynamicInstrumentationClient(API_HOST);
      const res = await client.fetchConfigurations('svc', 'prod', InstrumentationType.BREAKPOINT);

      expect(res.Changed).toBe(true); // defaults to true
      expect(res.SyncedAt).toBeNull();
      expect(res.SyncInterval).toBeNull();
      scope.done();
    });
  });

  describe('reportStatus', function () {
    it('POSTs the status report to the status endpoint', async function () {
      let captured: Record<string, unknown> = {};
      const scope = nock(API_HOST)
        .post(STATUS_PATH, body => {
          captured = body;
          return true;
        })
        .reply(200, {});

      const request: ReportStatusRequest = {
        Service: 'svc',
        Environment: 'prod',
        Configurations: [
          {
            InstrumentationType: InstrumentationType.BREAKPOINT,
            SignalType: SNAPSHOT_SIGNAL_TYPE,
            LocationHash: 'h1',
            Status: ConfigurationStatus.READY,
            Time: 123,
          },
        ],
      };

      const client = new DynamicInstrumentationClient(API_HOST);
      await client.reportStatus(request);

      expect(captured.Service).toBe('svc');
      expect((captured.Configurations as unknown[]).length).toBe(1);
      scope.done();
    });

    it('rejects when the status endpoint returns an error', async function () {
      const scope = nock(API_HOST).post(STATUS_PATH).reply(500, 'err');

      const client = new DynamicInstrumentationClient(API_HOST);
      await expect(client.reportStatus({ Service: 'svc', Environment: 'prod', Configurations: [] })).rejects.toThrow(
        'HTTP 500'
      );
      scope.done();
    });
  });
});
