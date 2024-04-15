/*
 *   Exchange Interface
 *
 */

import { Constants } from "../util/constants";
import { Orderbook, OrderStatus } from "../interfaces";

export abstract class BaseClient {
  protected accountBalances: { [symbol: string]: number };
  protected orderData: { [symbol: string]: Orderbook | undefined };

  constructor() {
    this.orderData = {};
    this.accountBalances = {};
  }

  public async refreshOrderbooks() {
    const promises: Promise<any>[] = [];
    Constants.symbols.forEach((base) => {
      Constants.stableSymbols.forEach((quote) => {
        promises.push(this._refreshOrderbooks(base, quote));
      });
    });

    return Promise.allSettled(promises);
  }

  public abstract initialize(): Promise<void>;

  public getOrderbook(symbol: string): Orderbook | undefined {
    return this.orderData[symbol];
  }

  public invalidateOrderbook(symbol: string) {
    delete this.orderData[symbol];
  }

  public abstract _refreshOrderbooks(base: string, quote: string): Promise<any>;
  public abstract getBalance(symbol: string): Promise<number>;
  public abstract refreshBalance(): void;

  public abstract createOrder(
    base: string,
    quote: string,
    side: string,
    type: string,
    amount: number,
    price: number,
  ): Promise<[{}, string]>;
  public abstract cancelOpenOrders(base: string, quote: string): void;

  public abstract queryOrder(
    base: string,
    quote: string,
    orderId: string,
  ): Promise<OrderStatus>;
}
