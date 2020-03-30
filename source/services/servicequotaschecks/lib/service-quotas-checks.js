/*********************************************************************************************************************
 *  Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * @author Solution Builders
 */

'use strict';
const AWS = require('aws-sdk');
const LOGGER = new (require('./logger'))();

const chromium = require('chrome-aws-lambda');

const url = require('url');
const qs = require('querystring');

class ServiceQuotasChecks {
    constructor() {
        AWS.config.update({region: 'cn-north-1'});
        this.limits_map = {};
    }



    /**
     * Creates the parameter to get the cloudwatch metrics for the vCPU type
     * @param {string} vCPU_type vCPU type for the cloudwatch metric
     */

    createCloudwatchParamsForInstanceTypes(vCPU_type){

        /**
         * Gets the start and end times for the currnet 5 minute window
         */

        let  getUsageWindow = function() {
            let start_time = (Math.round((new Date()).getTime() / 1000)-300);
            let end_time = (Math.round((new Date()).getTime() / 1000));
            return[start_time,end_time];
        };
        let cloudwatch_param =
            {
                StartTime: getUsageWindow()[0],
                EndTime: getUsageWindow()[1],
                MetricDataQueries: [{
                    Id: 'm1',
                    MetricStat: {
                        Metric: {
                            Namespace: 'AWS/Usage',
                            MetricName: 'ResourceCount',
                            Dimensions: [{
                                Name: 'Service',
                                Value: 'EC2'
                            },
                                {
                                    Name: 'Resource',
                                    Value: 'vCPU'
                                },
                                {
                                    Name: 'Type',
                                    Value: 'Resource'
                                },
                                {
                                    Name: 'Class',
                                    Value: ''
                                }
                            ]
                        },
                        Period: 300,
                        Stat: 'Maximum'
                    }
                }]
            };
        cloudwatch_param.MetricDataQueries[0].MetricStat.Metric.Dimensions[3].Value = vCPU_type.UsageMetric.MetricDimensions.Class;
        return cloudwatch_param;
    }


    /**
     * Gets the usage for the vCPU type from CloudWatch
     * @param {string} checkName
     * @param {string} params
     * @param {object} valid_regions
     */
    async getServiceUsage(checkName, params, valid_regions) {
        let usage_map = {};
        let region_map = {};
        for (let currentRegion of valid_regions) {
            AWS.config.update({region: currentRegion});
            let cloudwatch = new AWS.CloudWatch();
            try {
                let response = await cloudwatch.getMetricData(params).promise();
                if (response.MetricDataResults[0].Values[0] !== undefined) {
                    let maxUsage = response.MetricDataResults[0].Values[0]
                    region_map[currentRegion] = maxUsage;
                }
            } catch (err) {
                LOGGER.log('ERROR', err);
            }
        }
        usage_map[checkName]=region_map;
        return usage_map;
    }

    /**
     * Pushes the event to the event bridge for primary and spoke accounts
     * push到eventbridge的代码
     * @param {string} checkName
     * @param {string} statusColor
     * @param {number} currentUsage
     * @param {string} region
     * @param {string} service
     * @param {string} statusMessage
     * @param {number} currentServiceLimit
     */

    async pushEventToEventbridge(checkName, statusColor, currentUsage, region, service, statusMessage,currentServiceLimit) {
        AWS.config.update({region: 'cn-north-1'});
        let detailObj= {
            "checkname": checkName,
            "status": statusMessage,
            "check-item-detail": {
                "Status":statusColor,
                "Current Usage":currentUsage,
                "Limit Name":checkName,
                "Region":region,
                "Service":service,
                "Limit Amount":currentServiceLimit,
                "status": statusMessage
            },
        }
        let params = {
            Entries: [
                {
                    Source: "limit-monitor-solution",
                    DetailType: "Limit Monitor Checks",
                    Detail:JSON.stringify(detailObj),
                }
            ]
        };
        let eventBridge = new AWS.EventBridge();
        try {
            LOGGER.log('DEBUG', params);
            await eventBridge.putEvents(params).promise();
        } catch (err) {
            LOGGER.log('ERROR', err);
        }
    }

    /**
     * Performs limit check to see if the limit threshold is exceeded
     * 如果超了的话，就push到eventbridge里面
     * @param {string} checkName
     * @param {stirng} service
     * @param {object} params_limits
     * @param {object} params_usage
     * @param {object} valid_regions
     */

    async performLimitCheck(checkName, service,params_usage,valid_regions) {
        try {
            //LOGGER.log('performlimitcheck for checkName', checkName);
            //let serviceLimitPromise = this.getServiceLimits(checkName, valid_regions);
            let serviceUsagePromise = this.getServiceUsage(checkName, params_usage, valid_regions);
            let serviceLimit = this.limits_map;
            let serviceUsage = await serviceUsagePromise;
            let serviceUsageMap = serviceUsage[checkName];
            let serviceLimitMap = serviceLimit[checkName];
            for(let region in serviceUsageMap) {
                LOGGER.log('INFO', 'performlimitcheck in'+region);
                let currentRegion = region;
                let currentServiceLimit = serviceLimitMap[currentRegion];
                let currentUsage = serviceUsageMap[currentRegion];
                LOGGER.log('INFO', 'currentUsage'+currentUsage);
                LOGGER.log('INFO','serviceUsageMap'+ serviceUsageMap[currentRegion]);

                if (currentUsage >= currentServiceLimit) {
                    try {
                        await this.pushEventToEventbridge(checkName, "RED", currentUsage, currentRegion, service, "ERROR", currentServiceLimit);
                    }catch(err){
                        LOGGER.log('ERROR', err);
                    }
                }else if (currentUsage >= process.env.LIMIT_THRESHOLD * currentServiceLimit) {
                    try{
                        await this.pushEventToEventbridge(checkName, "YELLOW", currentUsage, currentRegion, service, "WARN", currentServiceLimit);
                    }catch(err){
                        LOGGER.log('ERROR', err);
                    }
                }else {
                    LOGGER.log("DEBUG", checkName);
                }
            }
        } catch (err) {
            LOGGER.log('ERROR', err);
        }
    };


    async simulatechrome(){
        let browser = null;
        let vCPU_Types = null;

        try {
            LOGGER.log('INFO','launch browser');
            browser = await chromium.puppeteer.launch({
                args: chromium.args,
                executablePath: await chromium.executablePath,
                defaultViewport: chromium.defaultViewport,
                headless: chromium.headless
            });

            LOGGER.log('INFO','open a new page');
            let page = await browser.newPage();
            await page.setRequestInterception(true);

            LOGGER.log('INFO','block image/css/font requests');
            this.blockUselessRequests(page);

            LOGGER.log('INFO','goto ec2 limit page');
            await page.goto('https://cn-north-1.console.amazonaws.cn/ec2/v2/home?region=cn-north-1#Limits:');
            const navigationPromise = page.waitForNavigation();

            await this.fillInput(page, 'input#account', this.account);
            await this.fillInput(page, 'input#username', this.username);
            await this.fillInput(page, 'input#password', this.password);

            // click login button
            await page.waitForSelector('#signin_button');
            await page.click('#signin_button');

            // wait for page loading
            await navigationPromise;

            LOGGER.log('INFO','signin succeed, waiting for response');

            const limitResponse = await this.waitLimitResponse(page);

            let limitRecords = limitResponse.LimitRecords.filter(item => {
                // we need only vCPU limits
                return item.limitType === 'e-instance-size-limit';
            });

            await this.checkNameLimitation(limitRecords,"cn-north-1");
            //vCPU_Types =  transformLimitRecordsToVcpuTypes(limitRecords);
            //LOGGER.log('vCPU_TYPES', vCPU_Types);

            //模拟点击宁夏
            await page.goto('https://cn-northwest-1.console.amazonaws.cn/ec2/v2/home?region=cn-northwest-1#Limits:');
            const limitResponseNingxia = await this.waitLimitResponse(page);
            //LOGGER.log('limitRecords', limitResponseNingxia);
            let limitRecords2 = limitResponseNingxia.LimitRecords.filter(item => {
                // we need only vCPU limits
                return item.limitType === 'e-instance-size-limit';
            });

            await this.checkNameLimitation(limitRecords2,"cn-northwest-1");
            LOGGER.log('INFO',this.limits_map);

            if (browser !== null) {
                await browser.close();
            }

            return this.transformLimitRecordsToVcpuTypes(limitRecords);
        }
        catch (error) {
            LOGGER.log('ERROR', error);
            if (browser !== null) {
                await browser.close();
            }
            return [];
        }
    }


    /**
     * Handler function to invoke the limit check functions
     */
    async checkForVCPULimits() {
        //if(await this.checkVCPUOptIn()) {

        //this.getSSMParameters();

        let account_res = await this.getAccountSSMParameters();
        this.account = account_res.Parameter.Value;

        let username_res = await this.getUsernameSSMParameters();
        this.username = username_res.Parameter.Value;

        let password_res = await this.getPWSSMParameters();
        this.password = password_res.Parameter.Value;

        let instances_types =await this.simulatechrome();

        let valid_regions = ["cn-north-1","cn-northwest-1"];

        for (let vCPUType of instances_types) {

            //QuotaName: example, running on-demand G instances
            let vCPU_limit_name = vCPUType.QuotaName;

            //为了拿到class，为每个的class复制，比如G/ondemand
            let vCPU_cloudwatch_params = await this.createCloudwatchParamsForInstanceTypes(vCPUType)

            await this.performLimitCheck(vCPU_limit_name, "EC2", vCPU_cloudwatch_params, valid_regions);
        }


        //}
    }
    async getAccountSSMParameters(){
        let ssm = new AWS.SSM({region: 'cn-north-1'});
        return  await  ssm.getParameter({
            Name: 'ACCOUNT'
        }).promise();
    }

    async getUsernameSSMParameters(){
        let ssm = new AWS.SSM({region: 'cn-north-1'});
        return await  ssm.getParameter({
            Name: 'USERNAME'
        }).promise();
    }

    async getPWSSMParameters(){
        let ssm = new AWS.SSM({region: 'cn-north-1'});
        return  await  ssm.getParameter({
            Name: 'PASSWORD'
        }).promise();
    }

    checkNameLimitation(limitRecords,regionCode){
        for (let limit of limitRecords) {
            if (this.limits_map[limit.description] == null){
                let region_map={};
                region_map[regionCode] = limit.limitValue;
                this.limits_map[limit.description] = region_map;
            }else{
                this.limits_map[limit.description][regionCode] = limit.limitValue;
            }

        }
    }

    transformLimitRecordsToVcpuTypes(limitRecords) {
        let vCPU_Types = [];
        for (let limit of limitRecords) {
            const regexInstanceClass = /Running On-Demand (\w+) .*instances/;
            const instanceClass = regexInstanceClass.exec(limit.description)[1];
            const usageMetricDimensionsClass = [instanceClass, 'OnDemand'].join('/');

            let ServiceCode = 'ec2',
                ServiceName = 'Amazon Elastic Compute Cloud (Amazon EC2)',
                QuotaArn = null,
                QuotaCode = null,
                QuotaName = limit.description,
                Value = limit.limitValue,
                Unit = 'None',
                Adjustable = true,
                GlobalQuota = false,
                UsageMetric = {
                    MetricNamespace: 'AWS/Usage',
                    MetricName: 'ResourceCount',
                    MetricDimensions: {
                        Class: usageMetricDimensionsClass, // e.g. Standard/OnDemand
                        Resource: 'vCPU',
                        Service: 'EC2',
                        Type: 'Resource'
                    },
                    MetricStatisticRecommendation: 'Maximum'
                };
            vCPU_Types.push({
                ServiceCode, ServiceName, QuotaArn, QuotaCode, QuotaName,
                Value, Unit, Adjustable, GlobalQuota, UsageMetric
            });
        }

        return vCPU_Types;
    }

//block useless requests
    blockUselessRequests(page) {
        page.on('request', interceptedRequest => {
            if (['image', 'stylesheet', 'font'].indexOf(interceptedRequest.resourceType()) !== -1) {
                interceptedRequest.abort();
            }
            else {
                interceptedRequest.continue();
            }
        });
    }

//fill input
    async  fillInput(page, selector, content) {
        LOGGER.log('INFO',`automatic fill ${selector}`);
        await page.waitForSelector(selector);
        await page.type(selector, content);
    }

// wait response of getEffectiveLimits
    waitLimitResponse(page, timeout=30) {
        return new Promise((resolve, reject) => {
            page.on('response', async interceptedResponse => {
                const _request = interceptedResponse.request();
                const { pathname, query } = url.parse(_request.url());
                const callFn = qs.parse(query).call;

                if (!interceptedResponse.ok()       ||
                    _request.method() !== 'POST'    ||
                    callFn !== 'getEffectiveLimits' ||
                    pathname !== '/ec2/ecb')
                    return;

                let res = await interceptedResponse.json();
                resolve(res);
            });

            setTimeout(() => {
                reject('timeout waiting limit response');
            }, timeout * 1000);
        });
    }

}


module.exports=ServiceQuotasChecks;