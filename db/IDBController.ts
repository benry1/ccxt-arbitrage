import { ArbitrageTrade, BaseLog, RebalanceTrade } from "../interfaces";

export interface IDBController {
  logRebalance(rebalance: RebalanceTrade): Promise<boolean>;
  logArbitrage(arbitrage: ArbitrageTrade): Promise<boolean>;
  logBase(log: BaseLog): Promise<boolean>;

  getLatestBaseLog(base: string): Promise<BaseLog>;
}
