'use strict';

const wait = require('timers-ext/promise/sleep');
const { log, style, progress } = require('@serverless/utils/log');
const resolveAuthMode = require('@serverless/utils/auth/resolve-mode');
const apiRequest = require('@serverless/utils/api-request');
const promptWithHistory = require('@serverless/utils/inquirer/prompt-with-history');
const { awsRequest } = require('./utils');

const iamRoleStackName = 'Serverless-Inc-Role-Stack';
const cloudFormationServiceConfig = { name: 'CloudFormation', params: { region: 'us-east-1' } };

const waitUntilStackIsCreated = async (context) => {
  await wait(2000);
  const stackEvents = (
    await awsRequest(context, cloudFormationServiceConfig, 'describeStackEvents', {
      StackName: iamRoleStackName,
    })
  ).StackEvents;
  const failedStatusReasons = stackEvents
    .filter(({ ResourceStatus: status }) => {
      return status && status.endsWith('_FAILED');
    })
    .map(({ ResourceStatusReason: reason }) => reason);

  if (failedStatusReasons.length) {
    log.error(`Creating IAM Role failed:\n  - ${failedStatusReasons.join('\n  - ')}`);
    return false;
  }
  const statusEvent = stackEvents.find(
    ({ ResourceType: resourceType }) => resourceType === 'AWS::CloudFormation::Stack'
  );
  const status = statusEvent ? statusEvent.ResourceStatus : null;
  if (status && status.endsWith('_COMPLETE')) {
    if (status === 'CREATE_COMPLETE') return true;
    log.error('Creating IAM Role failed');
    return false;
  }
  return waitUntilStackIsCreated(context);
};

const waitUntilIntegrationIsReady = async (context) => {
  await wait(2000);
  const { integrations } = await apiRequest(`/api/integrations/?orgId=${context.org.orgId}`, {
    urlName: 'integrationsBackend',
  });
  if (integrations.some(({ vendorAccount }) => vendorAccount === context.awsAccountId)) return true;
  return waitUntilIntegrationIsReady(context);
};

module.exports = {
  async isApplicable(context) {
    const { isConsole } = context;

    if (!isConsole) {
      context.inapplicabilityReasonCode = 'NON_CONSOLE_CONTEXT';
      return false;
    }

    if (!(await resolveAuthMode())) {
      context.inapplicabilityReasonCode = 'NOT_LOGGED_IN';
      return false;
    }

    if (!context.org) {
      context.inapplicabilityReasonCode = 'UNRESOLVED_ORG';
      return false;
    }

    const { integrations } = await apiRequest(`/api/integrations/?orgId=${context.org.orgId}`, {
      urlName: 'integrationsBackend',
    });

    if (integrations.some(({ vendorAccount }) => vendorAccount === context.awsAccountId)) {
      log.notice();
      log.notice.success('Your AWS account is integrated with Serverless Console');
      context.inapplicabilityReasonCode = 'INTEGRATED';
      return false;
    }

    try {
      await awsRequest(context, cloudFormationServiceConfig, 'describeStacks', {
        StackName: iamRoleStackName,
      });
      log.warning(
        'Cannot integrate with Serverless Console: ' +
          'AWS account seems already integrated with other org'
      );
      context.inapplicabilityReasonCode = 'AWS_ACCOUNT_ALREADY_INTEGRATED';
      return false;
    } catch (error) {
      if (error.Code === 'ValidationError') return true;
      if (error.providerErrorCodeExtension === 'VALIDATION_ERROR') return true;
      throw error;
    }
  },

  async run(context) {
    const { stepHistory } = context;

    if (
      !(await promptWithHistory({
        message: `Press [Enter] to enable Serverless Console's next-generation monitoring.\n\n${style.aside(
          [
            'This will create an IAM Role in your AWS account with the following permissions:',
            '- Subscribe to CloudWatch logs and metrics',
            '- Update Lambda layers and env vars to add tracing and real-time logging',
            '- Read resource info for security alerts',
            `See the IAM Permissions transparently here: ${style.link(
              'https://slss.io/iam-role-permissions'
            )}`,
          ]
        )}`,
        type: 'confirm',
        name: 'shouldSetupConsoleIamRole',
        stepHistory,
      }))
    ) {
      return false;
    }

    log.notice();

    const iamRoleCreationProgress = progress.get('iam-role-creation');
    iamRoleCreationProgress.notice('Creating IAM Role for Serverless Console');

    try {
      const { cfnTemplateUrl, params } = await apiRequest(
        `/api/integrations/aws/initial?orgId=${context.org.orgId}`,
        { urlName: 'integrationsBackend' }
      );

      await awsRequest(context, cloudFormationServiceConfig, 'createStack', {
        Capabilities: ['CAPABILITY_NAMED_IAM'],
        StackName: iamRoleStackName,
        TemplateURL: cfnTemplateUrl,
        Parameters: [
          { ParameterKey: 'AccountId', ParameterValue: params.accountId },
          { ParameterKey: 'ReportServiceToken', ParameterValue: params.reportServiceToken },
          { ParameterKey: 'ExternalId', ParameterValue: params.externalId },
          { ParameterKey: 'Version', ParameterValue: params.version },
        ],
      });

      if (!(await waitUntilStackIsCreated(context))) return false;

      iamRoleCreationProgress.notice('Enabling Serverless Console Integration');

      await waitUntilIntegrationIsReady(context);

      log.notice.success('Your AWS account is integrated with Serverless Console');
    } finally {
      iamRoleCreationProgress.remove();
    }
    return true;
  },
  configuredQuestions: ['shouldSetupConsoleIamRole'],
};
