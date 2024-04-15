import { Exchange } from "ccxt";
import { initializeExchanges } from "../controller/exchangeController";
import { BaseLog, RebalanceTrade, ArbitrageTrade, ExchangeBalance } from "../interfaces";
import { Constants } from "../util/constants";
import { IDBController } from "./IDBController";
import { Document, MongoClient } from "mongodb";

const fs = require("fs");

export class MongoController implements IDBController {
  url;
  client;
  arbDB;
  base_coll = "_pool";
  arb_coll = "_arb";
  rebalance_coll = "_rebalance";

  constructor(url: string) {
    this.url = url;
    this.client = new MongoClient(url);
    this.arbDB = this.client.db("arbitrage");
  }

  logRebalance(rebalance: RebalanceTrade): Promise<boolean> {
    try {
      return this.arbDB
        .collection(`${rebalance.base}${this.rebalance_coll}`)
        .insertOne(rebalance)
        .then(() => true)
        .catch((e) => {
          console.error(
            `[LOG][ERROR] Failed to write ${rebalance.base} rebalance data to mongodb: `,
            e,
          );
          return false;
        });
    } catch (e) {
      console.error(
        `[LOG][ERROR] Failed to write ${rebalance.base} rebalance data to mongodb: `,
        e,
      );
      return Promise.resolve(false);
    }
  }
  logArbitrage(arbitrage: ArbitrageTrade): Promise<boolean> {
    try {
      return this.arbDB
        .collection(`${arbitrage.base}${this.arb_coll}`)
        .insertOne(arbitrage)
        .then(() => true)
        .catch((e) => {
          console.error(
            `[LOG][ERROR] Failed to write ${arbitrage.base} arbitrage trade to mongodb: `,
            e,
          );
          return false;
        });
    } catch (e) {
      console.error(
        `[LOG][ERROR] Failed to write ${arbitrage.base} arbitrage data to mongodb: `,
        e,
      );
      return Promise.resolve(false);
    }
  }
  logBase(log: BaseLog): Promise<boolean> {
    try {
      //@ts-ignore
      delete log["_id"];
      const date = new Date();
      log.timestamp = Date.now();
      log.dateTime =
        date.toLocaleDateString() +
        " " +
        date.getHours() +
        ":" +
        String(date.getMinutes()).padStart(2, "0") +
        ":" +
        String(date.getSeconds()).padStart(2, "0");

      console.info("Logging Base", log.base);
      return this.arbDB
        .collection(`${log.base}${this.base_coll}`)
        .insertOne(log)
        .then(() => true)
        .catch((e) => {
          console.error(
            `[LOG][ERROR] Failed to write ${log.base} baselog to mongodb: `,
            e,
          );
          return false;
        });
    } catch (e) {
      console.error(
        `[LOG][ERROR] Failed to write ${log.base} base data to mongodb: `,
        e,
      );
      return Promise.resolve(false);
    }
  }
  async getLatestBaseLog(base: string): Promise<BaseLog> {
    try {
      const agg = [{ $sort: { timestamp: -1 } }, { $limit: 1 }];
      const res: BaseLog = await this.arbDB
        .collection(`${base}${this.base_coll}`)
        .aggregate(agg)
        .toArray()
        .then((res: Document[]) => res[0] as unknown as BaseLog);
      if (!res) {
        return this.initialBaseLog(base);
      } else {
        return res;
      }
    } catch (e) {
      console.error(`[LOG][ERROR] Failed to get latest base log: ${e}`);
      return Promise.resolve({} as BaseLog);
    }
  }
  private initialBaseLog(base: string): BaseLog {
    const ret: BaseLog = {
      timestamp: Date.now(),
      dateTime: new Date().toString(),
      base: base,
      quote: "USDT",
      initialInvestment: 0,
      initialInvestmentVwap: 0,
      sumQuote: 0,
      sumBase: 0,
      sumBaseValue: 0,
      basePrice: 0,
      exchangeBalances: Constants.exchanges.reduce(
        (client_obj, exchange) => ({
          ...client_obj,
          [exchange]: {
            base: 0,
            baseValue: 0,
            quote: 0,
            exchangePrice: 0,
          },
        }), {}) as { [exchange: string]: ExchangeBalance },
      lastRebalanceTs: 0,
      lastRebalancePrice: 0,
      estimatedArbProfit: 0,
      estimatedRebalanceProfit: 0,
      estimatedFees: 0,
    };
    return ret;
  }
}
