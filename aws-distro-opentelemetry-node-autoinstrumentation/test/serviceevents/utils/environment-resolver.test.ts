// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import expect from 'expect';
import { resolveLocalEnvironment, stampLocalEnvironment } from '../../../src/serviceevents/utils/environment-resolver';

/**
 * The SDK-side resolver must produce the SAME aws.local.environment the CloudWatch
 * agent's awsapplicationsignals resolver produces, from the same OTel resource attributes.
 * Precedence: explicit deployment.environment[.name] → eks/k8s cluster/namespace →
 * ec2 ASG → ec2:default.
 */
describe('environment-resolver', function () {
  describe('resolveLocalEnvironment()', function () {
    it('explicit deployment.environment.name wins over everything', function () {
      expect(
        resolveLocalEnvironment({
          attributes: {
            'deployment.environment.name': 'my-env',
            'k8s.cluster.name': 'c',
            'k8s.namespace.name': 'ns',
            'cloud.platform': 'aws_eks',
            'ec2.tag.aws:autoscaling:groupName': 'asg',
          },
        })
      ).toBe('my-env');
    });

    it('legacy deployment.environment is honored', function () {
      expect(resolveLocalEnvironment({ attributes: { 'deployment.environment': 'legacy-env' } })).toBe('legacy-env');
    });

    it('EKS → eks:<cluster>/<namespace>', function () {
      expect(
        resolveLocalEnvironment({
          attributes: {
            'cloud.platform': 'aws_eks',
            'k8s.cluster.name': 'my-cluster',
            'k8s.namespace.name': 'default',
          },
        })
      ).toBe('eks:my-cluster/default');
    });

    it('EKS with missing namespace → UnknownNamespace', function () {
      expect(
        resolveLocalEnvironment({ attributes: { 'cloud.platform': 'aws_eks', 'k8s.cluster.name': 'my-cluster' } })
      ).toBe('eks:my-cluster/UnknownNamespace');
    });

    it('non-EKS Kubernetes → k8s:<cluster>/<namespace>', function () {
      expect(resolveLocalEnvironment({ attributes: { 'k8s.cluster.name': 'c', 'k8s.namespace.name': 'team-a' } })).toBe(
        'k8s:c/team-a'
      );
    });

    it('ECS → ecs:<cluster> (cluster name from aws.ecs.cluster.arn)', function () {
      expect(
        resolveLocalEnvironment({
          attributes: {
            'cloud.platform': 'aws_ecs',
            'aws.ecs.cluster.arn': 'arn:aws:ecs:us-west-2:123456789012:cluster/my-ecs-cluster',
          },
        })
      ).toBe('ecs:my-ecs-cluster');
    });

    it('explicit environment still wins over ECS cluster', function () {
      expect(
        resolveLocalEnvironment({
          attributes: {
            'deployment.environment.name': 'prod',
            'cloud.platform': 'aws_ecs',
            'aws.ecs.cluster.arn': 'arn:aws:ecs:us-west-2:123456789012:cluster/my-ecs-cluster',
          },
        })
      ).toBe('prod');
    });

    it('EC2 with ASG → ec2:<asg>', function () {
      expect(resolveLocalEnvironment({ attributes: { 'ec2.tag.aws:autoscaling:groupName': 'my-asg' } })).toBe(
        'ec2:my-asg'
      );
    });

    it('EC2 without ASG → ec2:default', function () {
      expect(resolveLocalEnvironment({ attributes: { 'cloud.platform': 'aws_ec2' } })).toBe('ec2:default');
    });

    it('empty attributes (non-AWS / undetected host) → "generic:default" (matches agent generic resolver)', function () {
      expect(resolveLocalEnvironment({ attributes: {} })).toBe('generic:default');
    });

    it('non-AWS host with only service.name/host.name → "generic:default"', function () {
      expect(resolveLocalEnvironment({ attributes: { 'service.name': 'svc', 'host.name': 'my-vm' } })).toBe(
        'generic:default'
      );
    });

    it('EC2 detected via host.id → ec2:default', function () {
      expect(resolveLocalEnvironment({ attributes: { 'cloud.platform': 'aws_ec2', 'host.id': 'i-0abc' } })).toBe(
        'ec2:default'
      );
    });

    it('stampLocalEnvironment stamps generic:default on a non-AWS host', function () {
      const attrs: Record<string, string> = { 'service.name': 'svc' };
      stampLocalEnvironment(attrs);
      expect(attrs['aws.local.environment']).toBe('generic:default');
    });
  });

  describe('stampLocalEnvironment()', function () {
    it('stamps aws.local.environment from the resolved value', function () {
      const attrs: Record<string, string> = {
        'cloud.platform': 'aws_eks',
        'k8s.cluster.name': 'my-cluster',
        'k8s.namespace.name': 'default',
      };
      stampLocalEnvironment(attrs);
      expect(attrs['aws.local.environment']).toBe('eks:my-cluster/default');
    });

    it('does not overwrite an existing aws.local.environment', function () {
      const attrs: Record<string, string> = {
        'aws.local.environment': 'already-set',
        'k8s.cluster.name': 'c',
        'k8s.namespace.name': 'ns',
        'cloud.platform': 'aws_eks',
      };
      stampLocalEnvironment(attrs);
      expect(attrs['aws.local.environment']).toBe('already-set');
    });
  });
});
