/*
 * Copyright 2017 Brigham Young University
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
const expect = require('chai').expect;
const AWS = require('aws-sdk-mock');
const codepipelineCalls = require('../../dist/aws/codepipeline-calls');
const sinon = require('sinon');
const iamCalls = require('../../dist/aws/iam-calls');

describe('codepipelineCalls module', function () {
    let sandbox;

    beforeEach(function () {
        sandbox = sinon.sandbox.create();
    });

    afterEach(function () {
        sandbox.restore();
        AWS.restore('CodePipeline');
    });

    describe('createPipeline', function () {
        it('should create the pipeline', function () {
            let pipelineName = "my-pipeline";
            let appName = 'my-app';
            let accountConfig = {
                account_id: 111111111111,
                region: 'us-west-2'
            };
            let pipelinePhases = [];
            let codePipelineBucketName = "FakeBucket";

            let role = {
                Arn: "FakeArn"
            }
            let createRoleStub = sandbox.stub(iamCalls, 'createRoleIfNotExists').returns(Promise.resolve(role));
            let createPolicyStub = sandbox.stub(iamCalls, 'createPolicyIfNotExists').returns(Promise.resolve(role));
            let attachPolicyStub = sandbox.stub(iamCalls, 'attachPolicyToRole').returns(Promise.resolve({}));
            let getRoleStub = sandbox.stub(iamCalls, 'getRole').returns(Promise.resolve(role));
            AWS.mock('CodePipeline', 'createPipeline', Promise.resolve({
                pipeline: {}
            }));

            return codepipelineCalls.createPipeline(appName, pipelineName, accountConfig, pipelinePhases, codePipelineBucketName)
                .then(pipeline => {
                    expect(createRoleStub.calledOnce).to.be.true;
                    expect(createPolicyStub.calledOnce).to.be.true;
                    expect(attachPolicyStub.calledOnce).to.be.true;
                    expect(getRoleStub.calledOnce).to.be.true;
                    expect(pipeline).to.deep.equal({});
                });
        });
    });

    describe('getPipeline', function () {
        it('should return null when the pipeline does not exist', function () {
            AWS.mock('CodePipeline', 'getPipeline', Promise.reject({
                code: 'PipelineNotFoundException'
            }));
            return codepipelineCalls.getPipeline('FakeName')
                .then(pipeline => {
                    expect(pipeline).to.be.null;
                });
        });

        it('should return the pipeline when it exists', function () {
            AWS.mock('CodePipeline', 'getPipeline', Promise.resolve({
                pipeline: {}
            }));
            return codepipelineCalls.getPipeline('FakeName')
                .then(pipeline => {
                    expect(pipeline).to.deep.equal({});
                });
        });
    });

    describe('updatePipeline', function() {
        it('should update the pipeline', function() {
            let accountConfig = {
                account_id: 111111111111,
                region: 'us-west-2'
            };
            let pipelinePhases = [];

            let getRoleStub = sandbox.stub(iamCalls, 'getRole').returns(Promise.resolve({
                Arn: "FakeArn"
            }));
            AWS.mock('CodePipeline', 'updatePipeline', Promise.resolve({
                pipeline: {}
            }));

            return codepipelineCalls.updatePipeline("my-app", "my-pipeline", accountConfig, pipelinePhases, "FakeBucket")
                .then(pipeline => {
                    expect(getRoleStub.calledOnce).to.be.true;
                    expect(pipeline).to.deep.equal({});
                });
        });
    });

    describe('deletePipeline', function() {
        it('should delete the pipeline', function() {
            AWS.mock('CodePipeline', 'deletePipeline', Promise.resolve(true));

            return codepipelineCalls.deletePipeline("FakeApp", "FakePipeline")
                .then(success => {
                    expect(success).to.equal(true);
                });
        });
    });
});