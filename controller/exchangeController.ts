/****************************************
 *
 *  Any interaction with Exchange Clients
 *  should come through the exchange controller.
 *  This also has functions that iterate over
 *  all exchanges.
 *
 *
 ****************************************/
import { Constants } from "../util/constants";
import { CachedExchangeBalances, Orderbook } from "../interfaces";
import { Client } from "../api/Client";
require("dotenv").config();

/*
 *   Clients and exchange variables
 *
 */

const clients: { [exch: string]: Client } = Constants.exchanges.reduce(
  (client_obj, exchange) => ({
    ...client_obj,
    [exchange]: new Client(exchange, 0.003, {
      apiKey: process.env[`${exchange}ApiKey`]!,
      secret: process.env[`${exchange}ApiSecret`]!,
    }),
  }),
  {},
);

export function getClient(exchange: string) {
  return clients[exchange];
}

export function getTradeFees(exchange: string): number {
  return clients[exchange].fee;
}

export async function initializeExchanges() {
  //Refresh exchange balances
  return await Promise.allSettled(
    Constants.exchanges.map((exchange) => clients[exchange].initialize()),
  );
}

/*
 *   Get Exchange Info
 *
 */

export function getOrderbooks(base: string): { [exchange: string]: Orderbook } {
  var composite: { [exch: string]: Orderbook } = {};
  Constants.exchanges.forEach((exchange) => {
    if (clients[exchange].getOrderbook(base)) {
      composite[exchange] = clients[exchange].getOrderbook(base)!;
    }
  });
  return composite;
}

export function getExchangePrice(exch: string, base: string): number {
  const ob = getOrderbooks(base)[exch];
  return (ob?.asks[0].price + ob?.bids[0].price) / 2 ?? 0;
}

export async function getBalance(
  exchange: string,
  asset: string,
): Promise<number> {
  return await clients[exchange].getBalance(asset);
}

export async function getAllBalances(): Promise<CachedExchangeBalances> {
  const ret: CachedExchangeBalances = {};
  for (const exchange of Constants.exchanges) {
    ret[exchange] = {};
    for (const asset of Constants.symbols.concat(Constants.stableSymbols)) {
      ret[exchange][asset] = await getBalance(exchange, asset);
    }
  }
  return ret;
}

export function refreshOrderbooks(): Promise<any>[] {
  const promises: Promise<any>[] = [];
  let a = Date.now();
  Constants.exchanges.forEach((exch) => {
    promises.push(
      clients[exch]
        .refreshOrderbooks()
        .then((done) => console.debug(`Fetched ${exch} Orderbooks in ${Date.now() - a}`)),
    );
  });
  return promises;
}

export function deleteOrderbook(exch: string, base: string) {
  clients[exch].invalidateOrderbook(base);
}
