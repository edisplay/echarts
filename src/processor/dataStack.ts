/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

import {createHashMap, each} from 'zrender/src/core/util';
import GlobalModel from '../model/Global';
import SeriesModel from '../model/Series';
import { SeriesOption, SeriesStackOptionMixin } from '../util/types';
import SeriesData, { DataCalculationInfo } from '../data/SeriesData';
import { addSafe } from '../util/number';

type StackInfo = Pick<
    DataCalculationInfo<SeriesOption & SeriesStackOptionMixin>,
    'stackedDimension'
    | 'isStackedByIndex'
    | 'stackedByDimension'
    | 'stackResultDimension'
    | 'stackedOverDimension'
> & {
    data: SeriesData
    seriesModel: SeriesModel<SeriesOption & SeriesStackOptionMixin>
};

// (1) [Caution]: the logic is correct based on the premises:
//     data processing stage is blocked in stream.
//     See <module:echarts/stream/Scheduler#performDataProcessorTasks>
// (2) Only register once when import repeatedly.
//     Should be executed after series is filtered and before stack calculation.
export default function dataStack(ecModel: GlobalModel) {
    const stackInfoMap = createHashMap<StackInfo[]>();
    ecModel.eachSeries(function (seriesModel: SeriesModel<SeriesOption & SeriesStackOptionMixin>) {
        const stack = seriesModel.get('stack');
        // Compatible: when `stack` is set as '', do not stack.
        if (stack) {
            const stackInfoList = stackInfoMap.get(stack) || stackInfoMap.set(stack, []);
            const data = seriesModel.getData();

            const stackInfo: StackInfo = {
                // Used for calculate axis extent automatically.
                // TODO: Type getCalculationInfo return more specific type?
                stackResultDimension: data.getCalculationInfo('stackResultDimension'),
                stackedOverDimension: data.getCalculationInfo('stackedOverDimension'),
                stackedDimension: data.getCalculationInfo('stackedDimension'),
                stackedByDimension: data.getCalculationInfo('stackedByDimension'),
                isStackedByIndex: data.getCalculationInfo('isStackedByIndex'),
                data: data,
                seriesModel: seriesModel
            };

            // If stacked on axis that do not support data stack.
            if (!stackInfo.stackedDimension
                || !(stackInfo.isStackedByIndex || stackInfo.stackedByDimension)
            ) {
                return;
            }

            stackInfoList.push(stackInfo);
        }
    });

    // Process each stack group
    stackInfoMap.each(function (stackInfoList) {
        if (stackInfoList.length === 0) {
            return;
        }
        // Check if stack order needs to be reversed
        const firstSeries = stackInfoList[0].seriesModel;
        const stackOrder = firstSeries.get('stackOrder') || 'seriesAsc';

        if (stackOrder === 'seriesDesc') {
            stackInfoList.reverse();
        }

        // Set stackedOnSeries for each series in the final order
        each(stackInfoList, function (stackInfo, index) {
            stackInfo.data.setCalculationInfo(
                'stackedOnSeries',
                index > 0 ? stackInfoList[index - 1].seriesModel : null
            );
        });

        // Calculate stack values
        calculateStack(stackInfoList);
    });
}

function calculateStack(stackInfoList: StackInfo[]) {
    each(stackInfoList, function (targetStackInfo, idxInStack) {
        const resultVal: number[] = [];
        const resultNaN = [NaN, NaN];
        const dims: [string, string] = [targetStackInfo.stackResultDimension, targetStackInfo.stackedOverDimension];
        const targetData = targetStackInfo.data;
        const isStackedByIndex = targetStackInfo.isStackedByIndex;
        const stackStrategy = targetStackInfo.seriesModel.get('stackStrategy') || 'samesign';

        // Should not write on raw data, because stack series model list changes
        // depending on legend selection.
        targetData.modify(dims, function (v0, v1, dataIndex) {
            let sum = targetData.get(targetStackInfo.stackedDimension, dataIndex) as number;

            // Consider `connectNulls` of line area, if value is NaN, stackedOver
            // should also be NaN, to draw a appropriate belt area.
            if (isNaN(sum)) {
                return resultNaN;
            }

            let byValue: number;
            let stackedDataRawIndex;

            if (isStackedByIndex) {
                stackedDataRawIndex = targetData.getRawIndex(dataIndex);
            }
            else {
                byValue = targetData.get(targetStackInfo.stackedByDimension, dataIndex) as number;
            }

            // If stackOver is NaN, chart view will render point on value start.
            let stackedOver = NaN;

            for (let j = idxInStack - 1; j >= 0; j--) {
                const stackInfo = stackInfoList[j];

                // Has been optimized by inverted indices on `stackedByDimension`.
                if (!isStackedByIndex) {
                    stackedDataRawIndex = stackInfo.data.rawIndexOf(stackInfo.stackedByDimension, byValue);
                }

                if (stackedDataRawIndex >= 0) {
                    const val = stackInfo.data.getByRawIndex(
                        stackInfo.stackResultDimension, stackedDataRawIndex
                    ) as number;

                    // Considering positive stack, negative stack and empty data
                    if (
                        stackStrategy === 'all' // single stack group
                        || (stackStrategy === 'positive' && val > 0)
                        || (stackStrategy === 'negative' && val < 0)
                        || (stackStrategy === 'samesign' && sum >= 0 && val > 0) // All positive stack
                        || (stackStrategy === 'samesign' && sum <= 0 && val < 0) // All negative stack
                    ) {
                        // The sum has to be very small to be affected by the
                        // floating arithmetic problem. An incorrect result will probably
                        // cause axis min/max to be filtered incorrectly.
                        sum = addSafe(sum, val);
                        stackedOver = val;
                        break;
                    }
                }
            }

            resultVal[0] = sum;
            resultVal[1] = stackedOver;

            return resultVal;
        });
    });
}
