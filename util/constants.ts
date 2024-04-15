// import { CCXWS } from "../price/ccxws";

import { db } from "../db";
import { BaseLog } from "../interfaces";

export class Constants {
  /*
   *	Required Config
   */

  static debug = process.env.DEBUG === "true";

  static oneHour = 60 * 60 * 1000;

  /*
   *	Conncetion Info
   */

  static exchanges: string[] = [
    "coinex", "gateio", /*"mexc",*/
    "bitrue", "bigone"
  ];
  static symbols = ["EXFI", "ETH"]
  //Only supports single value - planned on supporting multiple
  //This doesnt technically need to be a stable coin, could be BTC or any quote
  static stableSymbols = ["USDT"];

  /*
   *  Caches
   */
  public static initializeCache() {
    return Promise.all(
      Constants.symbols.map((base) =>
        db
          .getLatestBaseLog(base)
          .then((res) => (Constants.latestBaseLog[base] = res)),
      ),
    );
  }
  static latestBaseLog: { [base: string]: BaseLog } = {};
}
