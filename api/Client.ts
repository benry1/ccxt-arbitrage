require("dotenv").config();
import { Constants } from "../util/constants";
import { Ask, Bid, Orderbook, OrderStatus } from "../interfaces";
import { BaseClient } from "./BaseClient";
import * as ccxt from "ccxt";

export class Client extends BaseClient {
  protected client: ccxt.Exchange;
  name: string;
  lastBalanceRefreshTime: number = 0;
  fee: number;

  constructor(
    exchange: string,
    fee: number,
    authOptions?: { apiKey: string; secret: string },
  ) {
    super();

    this.name = exchange;
    this.fee = fee;
    //@ts-ignore //How to register exchange as a key of ccxt export?
    this.client = new ccxt[exchange](authOptions);
  }

  async initialize(): Promise<any> {
    await this.client.loadMarkets();
    const promises: Promise<any>[] = [];
    promises.push(this.refreshBalance());
    promises.push(this.refreshOrderbooks());
    return Promise.all(promises);
  }

  /*
   *     Orderbook Functions
   *
   */

  //TODO: Many single orderbook calls, or one multi-orderbook call is faster?
  async _refreshOrderbooks(base: string, quote: string) {
    if (`${base}/${quote}` in this.client.markets) {
      return this.client
        .fetchOrderBook(`${base}/${quote}`, 10)
        .then(
          (ob) =>
            (this.orderData[base] = this.convertOrderbook(ob, base, quote)),
        );
    }
    console.info(base, quote, "market is not in", this.name);
    return undefined;
  }

  convertOrderbook(
    old: ccxt.OrderBook,
    base: string,
    quote: string,
  ): Orderbook {
    var bids: Bid[] = old.bids.map((bid) => ({
      price: bid[0] || 0,
      volume: bid[1] || 0,
    }));
    var asks: Ask[] = old.asks.map((ask) => ({
      price: ask[0] || 0,
      volume: ask[1] || 0,
    }));
    return {
      exchange: this.name,
      bids: bids,
      asks: asks,
      base: base,
      quote: quote,
      timestamp: Date.now(),
      datetime: old.datetime || "",
    };
  }

  hasMarket(base: string, quote: string): boolean {
    return `${base}/${quote}` in this.client.markets;
  }

  /*
   *       Account Functions
   *
   */

  async getBalance(symbol: string): Promise<number> {
    if (Date.now() - this.lastBalanceRefreshTime >= 30000) {
      await this.refreshBalance();
    }

    return this.accountBalances[symbol];
  }

  public async refreshBalance() {
    this.lastBalanceRefreshTime = Date.now();
    return this.client
      .fetchBalance()
      .then((balance) => this.convertBalances(balance));
  }

  protected convertBalances(response: ccxt.Balances) {
    Constants.symbols.forEach((base) => {
      if (response[base]) {
        this.accountBalances[base.toUpperCase()] = response[base].free || 0;
      } else if (
        Constants.stableSymbols.map(
          (quote) => `${base}/${quote}` in this.client.markets,
        )
      ) {
        //If it was not in the response, but has a market, set to zero
        this.accountBalances[base.toUpperCase()] = 0;
      }
    });
    Constants.stableSymbols.forEach((asset) => {
      if (response[asset]) {
        this.accountBalances[asset.toUpperCase()] = response[asset].free || 0;
      } else {
        this.accountBalances[asset.toUpperCase()] = 0;
      }
    });
  }

  /*
   *  Trade Functions
   *
   */

  public async createOrder(
    base: string,
    quote: string,
    side: string,
    type: string,
    amount: number,
    price?: number,
  ): Promise<[{}, string]> {
    if (`${base}/${quote}` in this.client.markets)
      return this.client
        .createOrder(`${base}/${quote}`, type, side, amount, price)
        .then((order) => [order, order.id]);
    else return [{}, ""];
  }

  public async cancelOpenOrders(base: string, quote: string): Promise<void> {
    const orders = await this.client.fetchOpenOrders(`${base}/${quote}`);
    for (const order of orders) {
      await this.client.cancelOrder(order.id, `${base}/${quote}`);
    }
    return;
  }

  public async queryOrder(
    base: string,
    quote: string,
    orderId: string,
  ): Promise<OrderStatus> {
    return await this.client
      .fetchOrder(orderId, `${base}/${quote}`)
      .then((order) => this.parseOrderStatus(base, quote, order));
  }

  protected parseOrderStatus(
    base: string,
    quote: string,
    val: ccxt.Order,
  ): OrderStatus {
    //Figure out the fee
    let calculatedFee = 0;
    if (val.fee?.currency) {
      //There is fee info, and it specifies currency.
      calculatedFee = val.fee.cost || 0;
      const inQuote = val.fee.currency == quote;
      !inQuote ? (calculatedFee *= val.price) : null;
    } else {
      //No fee info - best guess time
      calculatedFee = val.filled * val.price * this.fee;
    }
    var orderStatus: OrderStatus = {
      orderId: val.id,
      response: val,
      fee: calculatedFee,
      executedBase: val.filled,
      executedQuote: val.filled * val.price,
      vwap: val.price,
    };
    return orderStatus;
  }
}
