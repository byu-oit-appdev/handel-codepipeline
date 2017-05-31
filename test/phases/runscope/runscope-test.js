const expect = require('chai').expect;
const runscope = require('../../../lib/phases/runscope');
const deployersCommon = require('../../../lib/phases/deployers-common');
const cloudFormationCalls = require('../../../lib/aws/cloudformation-calls');
const sinon = require('sinon');
const inquirer = require('inquirer');

describe('runscope module', function () {
    let sandbox;

    beforeEach(function () {
        sandbox = sinon.sandbox.create();
    });

    afterEach(function () {
        sandbox.restore();
    });

    describe('check', function () {
        it('should return an empty array', function () {
            let errors = runscope.check({});
            expect(errors).to.deep.equal([]);
        })
    });

    describe('getSecretsForPhase', function () {
        it('should prompt for the trigger URL and auth token', function () {
            let triggerUrl = "FakeUrl";
            let accessToken = "FakeToken";

            let promptStub = sandbox.stub(inquirer, 'prompt').returns(Promise.resolve({
                runscopeTriggerUrl: triggerUrl,
                runscopeAccessToken: accessToken
            }));

            return runscope.getSecretsForPhase()
                .then(results => {
                    expect(results.runscopeTriggerUrl).to.equal(triggerUrl);
                    expect(results.runscopeAccessToken).to.equal(accessToken);
                    expect(promptStub.calledOnce).to.be.true;
                });
        });
    });

    describe('createPhase', function () {
        let phaseContext = {
            phaseName: 'MyPhase',
            params: {},
            secrets: {
                runscopeTriggerUrl: 'MyTriggerUrl',
                runscopeAccessToken: 'MyAccessToken'
            }
        }
        let accountConfig = {
            account_id: '111111111111',
            region: 'us-west-2'
        }

        it('should create the role, upload the file, and create the stack when it doesnt exist', function () {
            let functionName = "MyFunction";
            let getStackStub = sandbox.stub(cloudFormationCalls, 'getStack').returns(Promise.resolve(null));
            let createLambdaRoleStub = sandbox.stub(deployersCommon, 'createLambdaCodePipelineRole').returns(Promise.resolve({
                Arn: "fakeArn"
            }));
            let uploadDirectoryStub = sandbox.stub(deployersCommon, 'uploadDirectoryToBucket').returns(Promise.resolve({
                Bucket: "fakeBucket",
                Key: "fakeKey"
            }));
            let createStackStub = sandbox.stub(cloudFormationCalls, 'createStack').returns(Promise.resolve({
                Outputs: [{
                    OutputKey: 'FunctionName',
                    OutputValue: functionName
                }]
            }));

            return runscope.createPhase(phaseContext, accountConfig)
                .then(phaseSpec => {
                    expect(getStackStub.calledOnce).to.be.true;
                    expect(createLambdaRoleStub.calledOnce).to.be.true;
                    expect(uploadDirectoryStub.calledOnce).to.be.true;
                    expect(createStackStub.calledOnce).to.be.true;
                    expect(phaseSpec.name).to.equal(phaseContext.phaseName);
                    expect(phaseSpec.actions[0].configuration.FunctionName).to.equal(functionName);
                });
        });

        it('should return the stack when it exists', function () {
            let functionName = "MyFunction";
            let getStackStub = sandbox.stub(cloudFormationCalls, 'getStack').returns(Promise.resolve({
                Outputs: [{
                    OutputKey: 'FunctionName',
                    OutputValue: functionName
                }]
            }));

            return runscope.createPhase(phaseContext, accountConfig)
                .then(phaseSpec => {
                    expect(getStackStub.calledOnce).to.be.true;
                    expect(phaseSpec.name).to.equal(phaseContext.phaseName);
                    expect(phaseSpec.actions[0].configuration.FunctionName).to.equal(functionName);
                });
        });
    });

    describe('deletePhase', function () {
        let phaseContext = {
            phaseName: 'FakePhase'
        }

        it('should delete the cloudformation stack if present', function () {
            let deleteStackStub = sandbox.stub(cloudFormationCalls, 'deleteStack').returns(Promise.resolve(true));
            let getStackStub = sandbox.stub(cloudFormationCalls, 'getStack').returns(Promise.resolve({}));
            return runscope.deletePhase(phaseContext, {})
                .then(result => {
                    expect(result).to.equal(true);
                    expect(getStackStub.calledOnce).to.be.true;
                    expect(deleteStackStub.calledOnce).to.be.true;
                });
        });

        it('should return true if the stack is already deleted', function () {
            let deleteStackStub = sandbox.stub(cloudFormationCalls, 'deleteStack').returns(Promise.resolve(true));
            let getStackStub = sandbox.stub(cloudFormationCalls, 'getStack').returns(Promise.resolve(null));
            return runscope.deletePhase(phaseContext, {})
                .then(result => {
                    expect(result).to.equal(true);
                    expect(getStackStub.calledOnce).to.be.true;
                    expect(deleteStackStub.notCalled).to.be.true;
                });
        });
    });

});