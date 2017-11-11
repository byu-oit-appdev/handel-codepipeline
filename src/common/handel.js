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
const ServiceContext = require('handel/lib/datatypes/service-context');
const EnvironmentContext = require('handel/lib/datatypes/environment-context');
const EnvironmentDeployResult = require('handel/lib/datatypes/environment-deploy-result');
const EnvironmentDeleteResult = require('handel/lib/datatypes/environment-delete-result');
const handelUtil = require('handel/lib/common/util');
const handelConfig = require('handel/lib/common/account-config');

const checkPhase = require('handel/lib/phases/check');

const preDeployPhase = require('handel/lib/phases/pre-deploy');
const bindPhase = require('handel/lib/phases/bind');
const deployPhase = require('handel/lib/phases/deploy');

const unPreDeployPhase = require('handel/lib/phases/un-pre-deploy');
const unBindPhase = require('handel/lib/phases/un-bind');
const unDeployPhase = require('handel/lib/phases/un-deploy');

const deployOrderCalc = require('handel/lib/deploy/deploy-order-calc');

const winston = require('winston');

const allowedHandelServices = ['apiaccess', 'dynamodb', 's3'];


exports.check = function checkResources(resources) {
    //TODO - This using a fake account config is pretty ugly. It'd be nice not to have to use it if possible
    //Use fake account config
    handelConfig({
        account_id: 111111111111,
        region: 'us-west-2',
        vpc: 'vpc-aaaaaaaa',
        public_subnets: [
            'subnet-ffffffff',
            'subnet-44444444'
        ],
        private_subnets: [
            'subnet-00000000',
            'subnet-77777777'
        ],
        data_subnets: [
            'subnet-eeeeeeee',
            'subnet-99999999'
        ],
        ecs_ami: 'ami-66666666',
        ssh_bastion_sg: 'sg-44444444',
        on_prem_cidr: '10.10.10.10/0'
    }).getAccountConfig();

    let errors = [];
    for (let name of Object.getOwnPropertyNames(resources)) {
        let resErrors = checkResource(name, resources[name]);
        errors = errors.concat(resErrors);
    }
    return errors;
};

exports.deploy = function deployResources(resources, phaseContext, accountConfig) {
    handelConfig(accountConfig).getAccountConfig();
    return new Promise((resolve, reject) => {
        try {
            let deployers = getServiceDeployers();

            winston.info('Validating and parsing resources');

            let envContext = createEnvironmentContext(resources, phaseContext, accountConfig);
            resolve(deployEnvironment(accountConfig, deployers, envContext));
        } catch (err) {
            reject(err);
        }
    });
};

exports.delete = function deleteResources(resources, phaseContext, accountConfig) {
    handelConfig(accountConfig).getAccountConfig();
    return new Promise((resolve, reject) => {
        try {
            let deployers = getServiceDeployers();

            winston.info('Validating and parsing resources');

            let envContext = createEnvironmentContext(resources, phaseContext, accountConfig);
            resolve(deleteEnvironment(accountConfig, deployers, envContext));
        } catch (err) {
            reject(err);
        }
    });
};

function getServiceDeployers() {
    let all = handelUtil.getServiceDeployers();

    let result = {};

    for (let service of allowedHandelServices) {
        result[service] = all[service];
    }

    return result;
}

function checkResource(name, config) {
    let deployers = getServiceDeployers();

    let type = config.type;

    let context = new ServiceContext('check', 'check', name, type, '1', config);

    let deployer = deployers[type];

    if (!deployer) {
        return [`service type '${type}' is not supported`];
    }

    return deployer.check(context);
}

function deployEnvironment(accountConfig, deployers, envContext) {
    let errors = checkPhase.checkServices(deployers, envContext);

    if (errors.length > 0) {
        return new EnvironmentDeployResult("failure", `Errors while checking deploy spec: \n${errors.join("\n")}`);
    }

    return preDeployPhase.preDeployServices(deployers, envContext)
        .then(preDeployResults => {
            let deployOrder = deployOrderCalc.getDeployOrder(envContext);
            return bindAndDeployServices(deployers, envContext, preDeployResults, deployOrder);
        }).then(result => {
            let policies = [];
            let environmentVars = {};
            for (let name of Object.getOwnPropertyNames(result.deployContexts)) {
                let ctx = result.deployContexts[name];
                policies = policies.concat(ctx.policies);
                Object.assign(environmentVars, ctx.environmentVariables)
            }
            return {
                policies: policies,
                environmentVariables: environmentVars,
                deployContexts: result.deployContexts
            }
        });
}

function bindAndDeployServices(serviceDeployers, environmentContext, preDeployContexts, deployOrder) {
    let deployProcess = Promise.resolve();
    let bindContexts = {};
    let deployContexts = {};
    for (let currentLevel = 0; deployOrder[currentLevel]; currentLevel++) {
        deployProcess = deployProcess
            .then(() => bindPhase.bindServicesInLevel(serviceDeployers, environmentContext, preDeployContexts, deployOrder, currentLevel))
            .then(levelBindResults => {
                for (let serviceName in levelBindResults) {
                    bindContexts[serviceName] = levelBindResults[serviceName]
                }
            })
            .then(() => deployPhase.deployServicesInLevel(serviceDeployers, environmentContext, preDeployContexts, deployContexts, deployOrder, currentLevel))
            .then(levelDeployResults => {
                for (let serviceName in levelDeployResults) {
                    deployContexts[serviceName] = levelDeployResults[serviceName]
                }
                return {
                    bindContexts,
                    deployContexts
                }
            });
    }

    return deployProcess;
}

function createEnvironmentContext(resources, phaseContext, accountConfig) {
    let app = phaseContext.appName;
    let pipeline = phaseContext.pipelineName;

    let envContext = new EnvironmentContext(app, '1', pipeline);
    for (let name of Object.getOwnPropertyNames(resources)) {
        let serviceSpec = resources[name];

        if (!serviceSpec.tags) {
            serviceSpec.tags = {}
        }

        serviceSpec.tags['handel-phase'] = phaseContext.phaseName;

        envContext.serviceContexts[name] = new ServiceContext(app, pipeline, name, serviceSpec.type, '1', serviceSpec);
    }
    return envContext;
}

function unDeployAndUnBindServices(serviceDeployers, environmentContext, deployOrder) {
    let deleteProcess = Promise.resolve();
    let unBindContexts = {};
    let unDeployContexts = {};
    for (let currentLevel = deployOrder.length - 1; deployOrder[currentLevel]; currentLevel--) {
        deleteProcess = deleteProcess
            .then(() => unDeployPhase.unDeployServicesInLevel(serviceDeployers, environmentContext, deployOrder, currentLevel))
            .then(levelUnDeployResults => {
                for (let serviceName in levelUnDeployResults) {
                    unDeployContexts[serviceName] = levelUnDeployResults[serviceName];
                }
            })
            .then(() => unBindPhase.unBindServicesInLevel(serviceDeployers, environmentContext, deployOrder, currentLevel))
            .then(levelUnBindResults => {
                for (let serviceName in levelUnBindResults) {
                    unBindContexts[serviceName] = levelUnBindResults[serviceName]
                }
                return {
                    unBindContexts,
                    unDeployContexts
                }
            });
    }

    return deleteProcess;
}


function deleteEnvironment(accountConfig, serviceDeployers, environmentContext) {
    if (!accountConfig || !environmentContext) {
        return Promise.resolve(new EnvironmentDeleteResult("failure", "Invalid configuration"));
    }
    else {
        winston.info(`Starting delete for environment ${environmentContext.environmentName}`);

        let deployOrder = deployOrderCalc.getDeployOrder(environmentContext);
        return unDeployAndUnBindServices(serviceDeployers, environmentContext, deployOrder)
            .then(unDeployAndUnBindResults => {
                return unPreDeployPhase.unPreDeployServices(serviceDeployers, environmentContext)
            })
            .then(unPreDeployResults => {
                return new EnvironmentDeleteResult("success");
            })
            .catch(err => {
                return new EnvironmentDeleteResult("failure", err.message, err);
            });
    }
}


