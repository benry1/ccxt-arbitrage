import { getOrderbooks } from "../controller/exchangeController";
import { Constants } from "./constants";
import {
  Ask,
  BaseLog,
  ExchangeBalance,
  Orderbook,
  TradeAnalysis,
} from "../interfaces";
import { db } from "../db";
import { getPoolBalance } from "../controller/PoolController";

// Check if we have roughly equal value balances.
// If we are off by more than 10%, rebalance
// Input: None
// Output: { side: "BUY" || "SELL", amount: number }
export async function determineRebalanceAmount(
  base: string,
): Promise<{ base: string; side: string; amount: number; ratio: number }> {
  var ret = {
    base,
    side: "SELL",
    amount: 0,
    ratio: -1,
  };

  //Estimate base price
  var fairPrice = getFairPrice(base);
  //Price estimation failed - we'll get 'em next time.
  if (fairPrice <= 0 || isNaN(fairPrice)) {
    console.error("[STATE][ERROR] Price estimation failed: ", fairPrice);
    return ret;
  }

  //Get sum of balances
  const usdtValue = getPoolBalance(base, "USDT").actual;
  const baseTotal = getPoolBalance(base, base).actual;
  const baseValue = getPoolBalance(base, base).value;

  var requiredRatio = 0.1;

  var ratio = (baseValue - usdtValue) / ((baseValue + usdtValue) / 2);
  ret.ratio = ratio;

  //If the ratio is acceptable, return with no requested trade
  if (Math.abs(ratio) < requiredRatio) {
    return ret;
  }

  if (ratio < 0) {
    //We need to buy base to equalize
    ret.side = "BUY";
  } else {
    //Sell base to equalize values
    ret.side = "SELL";
  }

  //How much?
  var requiredValue = Math.abs(baseValue - usdtValue) / 2;
  var requiredBase = requiredValue / fairPrice;
  ret.amount = requiredBase;

  console.debug(
    `Base amount: ${baseTotal}, FairPrice: ${fairPrice}, baseValue: ${baseValue}, usdt: ${usdtValue}`,
  );

  return ret;
}

export async function buildRebalancingTrade(request: {
  base: string;
  side: string;
  amount: number;
  ratio: number;
}): Promise<{ [exch: string]: TradeAnalysis }> {
  try {
    const fake_orderbook: Orderbook = {
      exchange: "",
      base: "",
      quote: "",
      timestamp: 0,
      asks: [],
      bids: [],
      datetime: "",
    };
    //Gather and sort valid orderbooks
    var orderbooks: { [exch: string]: Orderbook } = JSON.parse(
      JSON.stringify(getOrderbooks(request.base)),
    ); //Deep copy the orderbooks. We will be cannibalizing them

    //Initialize return object
    //We will prune out exchanges with 0 volume later
    var ret: { [exch: string]: TradeAnalysis } = {};
    Constants.exchanges.forEach((exchange) => {
      ret[exchange] = {
        base: request.base,
        quote: "USDT",
        exchange: exchange,
        volume: 0,
        side: "",
        offers: Array(),
        vwap: 0,
        orderbookTS: orderbooks[exchange].timestamp,
      };
    });

    var fulfilledTrade = 0;
    var fairPrice = getFairPrice(request.base);

    var balances: { [exchange: string]: { [asset: string]: number } } = {};
    for (var exchange of Constants.exchanges) {
      balances[exchange] = {};
      balances[exchange][request.base] = getPoolBalance(
        request.base,
        request.base,
        exchange,
      ).actual;
      balances[exchange]["USDT"] = getPoolBalance(
        request.base,
        "USDT",
        exchange,
      ).actual;
    }

    if (request.side == "BUY") {
      //Continually choose the lowest ask price from any exchange until our commitment is fulfilled
      while (fulfilledTrade < request.amount) {
        //This will be the lowest ask ** that we can afford with our current balance **
        var lowestAsk: Orderbook = orderbooks[Constants.exchanges[0]];

        //Check all exchanges for the smallest ask price
        Constants.exchanges.forEach((exchange) => {
          if (
            lowestAsk.asks.length == 0 || //Switch if our default has no asks
            (orderbooks[exchange].asks[0].price < lowestAsk.asks[0].price &&
              (balances[exchange]["USDT"] / fairPrice) * 0.99 >
                Math.min(
                  request.amount - fulfilledTrade,
                  orderbooks[exchange].asks[0].volume,
                ))
          ) {
            lowestAsk = orderbooks[exchange];
          }
        });

        //This should almost never happen, but if we run out of bids, just
        //send the trades we have.
        if (lowestAsk.asks.length == 0) {
          break;
        }

        //With the lowest ask price,
        //Use as much volume as necessary
        //To equalize the volumes
        if (request.amount - fulfilledTrade >= lowestAsk.asks[0].volume) {
          //Eat up this whole ask
          ret[lowestAsk.exchange].side = "BUY";
          ret[lowestAsk.exchange].volume += lowestAsk.asks[0].volume;
          fulfilledTrade += lowestAsk.asks[0].volume;
          balances[lowestAsk.exchange]["USDT"] -=
            lowestAsk.asks[0].volume * fairPrice;
          ret[lowestAsk.exchange].offers.push(lowestAsk.asks.shift()!);
        } else {
          //Eat up necessary part of ask
          ret[lowestAsk.exchange].side = "BUY";
          ret[lowestAsk.exchange].volume += request.amount - fulfilledTrade;
          var modifiedAsk: Ask = lowestAsk.asks.shift()!;
          modifiedAsk.volume = request.amount - fulfilledTrade;
          balances[lowestAsk.exchange]["USDT"] -=
            modifiedAsk.volume * fairPrice;
          fulfilledTrade += request.amount - fulfilledTrade;
          ret[lowestAsk.exchange].offers.push(modifiedAsk);
        }
      }
    } else if (request.side == "SELL") {
      //Continually choose the lowest ask price from any exchange until our commitment is fulfilled
      while (fulfilledTrade < request.amount) {
        //Highest bid ** that we can afford with our current balance **
        var highestBid: Orderbook = orderbooks[Constants.exchanges[0]];

        //Check all exchanges for the smallest ask price
        Constants.exchanges.forEach((exchange) => {
          if (
            highestBid.bids.length == 0 || //What if our default has empty bids?
            (orderbooks[exchange].bids[0].price > highestBid.bids[0].price && //This bid really is higher
              balances[exchange][request.base] * 0.99 >
                Math.min(
                  request.amount - fulfilledTrade,
                  orderbooks[exchange].bids[0].volume,
                ))
          ) {
            //And we have enough balance for the bid or remainder of volume
            highestBid = orderbooks[exchange];
          }
        });

        //This should almost never happen, but if we run out of bids, just
        //send the trades we have.
        if (highestBid.bids.length == 0) {
          break;
        }

        //With the lowest ask price,
        //Use as much volume as necessary
        //To equalize the volumes
        if (request.amount - fulfilledTrade >= highestBid.bids[0].volume) {
          //Eat up this whole ask
          ret[highestBid.exchange].side = "SELL";
          ret[highestBid.exchange].volume += highestBid.bids[0].volume;
          fulfilledTrade += highestBid.bids[0].volume;
          balances[highestBid.exchange][request.base] -=
            highestBid.bids[0].volume;

          const shift = highestBid.bids.shift();
          ret[highestBid.exchange].offers.push(shift!);
        } else {
          //Eat up necessary part of ask
          ret[highestBid.exchange].side = "SELL";
          ret[highestBid.exchange].volume += request.amount - fulfilledTrade;
          var modifiedAsk: Ask = highestBid.bids.shift()!;
          modifiedAsk.volume = request.amount - fulfilledTrade;
          balances[highestBid.exchange][request.base] -= modifiedAsk.volume;
          fulfilledTrade += request.amount - fulfilledTrade;
          ret[highestBid.exchange].offers.push(modifiedAsk);
        }
      }
    }

    Constants.exchanges.forEach((exchange) => {
      //Get rid of exchanges in ret that aren't involved
      if (ret[exchange].volume == 0) {
        delete ret[exchange];
        return;
      }

      //Calculate VWAP for each exchange
      let pv = 0;
      let tot_v = 0;
      ret[exchange].offers.forEach((offer) => {
        pv += offer.price * offer.volume;
        tot_v += offer.volume;
      });
      ret[exchange].vwap = pv / tot_v;
    });

    console.debug("[STATE][BUILDREBALANCE][DEBUG] Final rebalancing trades:");
    console.debug(JSON.stringify(ret, undefined, "  "));

    return ret;
  } catch (e) {
    //Hit some error - return no rebalancing trades
    console.error("[STATE][BUILDREBALANCE]", e);
    //TODO: Return a proper error value
    return {};
  }
}

export async function buildBaseLog(base: string): Promise<BaseLog> {
  var now = Date.now();
  var date = new Date();
  var dateString =
    date.toLocaleDateString() +
    " " +
    date.getHours() +
    ":" +
    String(date.getMinutes()).padStart(2, "0") +
    ":" +
    String(date.getSeconds()).padStart(2, "0");

  var fairPrice = getFairPrice(base);
  const latestBaseLog = await db.getLatestBaseLog(base);
  if (!latestBaseLog) {
    throw new Error(`Failed to get last base log for ${base}`);
  }

  var ret: BaseLog = {
    timestamp: now,
    dateTime: dateString,
    base: base,
    quote: "USDT",
    sumQuote: 0,
    sumBase: 0,
    sumBaseValue: 0,
    basePrice: fairPrice,
    exchangeBalances: {},
    initialInvestment: latestBaseLog.initialInvestment,
    initialInvestmentVwap: latestBaseLog.initialInvestmentVwap,
    estimatedArbProfit: latestBaseLog.estimatedArbProfit,
    estimatedRebalanceProfit: latestBaseLog.estimatedRebalanceProfit,
    estimatedFees: latestBaseLog.estimatedFees,
    lastRebalanceTs: latestBaseLog.lastRebalanceTs,
    lastRebalancePrice: latestBaseLog.lastRebalancePrice,
  };

  var exchangeBalances: { [exch: string]: ExchangeBalance } = {};

  const ob = await getOrderbooks(base); //base
  for (var exch of Constants.exchanges) {
    var baseNum = getPoolBalance(base, base, exch).actual;
    var quote = getPoolBalance(base, "USDT", exch).actual;
    var thisExchBalance: ExchangeBalance = {
      exchange: exch,
      quote: quote,
      base: baseNum,
      baseValue: baseNum * fairPrice,
      exchangePrice: (ob[exch].asks[0].price + ob[exch].bids[0].price) / 2,
    };
    exchangeBalances[exch] = thisExchBalance;
    ret.sumQuote += (quote || 0);
    ret.sumBase += (baseNum || 0);
    ret.sumBaseValue += (thisExchBalance.baseValue || 0);
  }

  ret.exchangeBalances = exchangeBalances;

  return ret;
}

//TODO: Detect and remove outliers
export function getFairPrice(base: string): number {
  var orderbooks: { [exchange: string]: Orderbook } = getOrderbooks(base);
  var entries = 0;
  var sumEntries = 0;

  Constants.exchanges.forEach((exchange) => {
    if (!orderbooks[exchange]) {
      return;
    }
    if (orderbooks[exchange].asks) {
      entries++;
      sumEntries += orderbooks[exchange].asks[0].price;
    }
    if (orderbooks[exchange].bids) {
      entries++;
      sumEntries += orderbooks[exchange].bids[0].price;
    }
  });

  if (entries == 0) {
    return -1;
  }

  return sumEntries / entries;
}
