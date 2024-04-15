/*************************
 * 
 * Any time a trade is necessary
 * this controller will handle it
 * 
 **************************/
import { db } from "../db";
import {
  ArbitrageAnalysis,
  OrderStatus,
  TradeExecution,
  ArbitrageTrade,
  TradeAnalysis,
  RebalanceTrade,
  ExchangeBalance,
  BaseLog,
} from "../interfaces";
import { Constants } from "../util/constants";
import { updatePoolBalance } from "./PoolController";
import {
  getTradeFees,
  getExchangePrice,
  getBalance,
  getClient,
} from "./exchangeController";

/*
 *
 *  Enact Arbitrage Trade
 *
 *   
 *
 */


export async function enactOpportunity(
  trade: ArbitrageAnalysis,
  untrimmedTrade: ArbitrageAnalysis,
) {
  if (Constants.debug) {
    debugOpportunity(trade);
  } else {
    //Store the ID along with the exchange order IDs
    //ID is simply a timestamp so we can query trades by date
    var arbitrageId = Date.now();
    var date = new Date();
    var dateString =
      date.toLocaleDateString() +
      " " +
      date.getHours() +
      ":" +
      String(date.getMinutes()).padStart(2, "0") +
      ":" +
      String(date.getSeconds()).padStart(2, "0");

    //No awaits here - more interested than firing off quickly than seeing response
    var finalSellPrice = trade.sell.offers[trade.sell.offers.length - 1].price;
    var sellSide: Promise<[{}, string]> = getClient(
      trade.sell.exchange,
    ).createOrder(
      trade.sell.base,
      trade.sell.quote,
      "SELL",
      "MARKET",
      trade.sell.volume,
    );

    var finalBuyPrice = trade.buy.offers[trade.buy.offers.length - 1].price;
    var buySide: Promise<[{}, string]> = getClient(
      trade.buy.exchange,
    ).createOrder(
      trade.buy.base,
      trade.buy.quote,
      "BUY",
      "MARKET",
      trade.buy.volume,
    );

    //Wait for the trades to finish up so we can collect the data we need
    var buySideSettled: [{}, string] = await buySide;
    var sellSideSettled: [{}, string] = await sellSide;

    //Let the trades settle in the system before checking status
    //Maybe unnecessary, idk
    await new Promise((r) => setTimeout(r, 2000));

    //Find out how much of each order filled
    var buyStatus: OrderStatus = await getClient(trade.buy.exchange).queryOrder(
      trade.buy.base,
      trade.buy.quote,
      buySideSettled[1],
    );
    var sellStatus: OrderStatus = await getClient(
      trade.sell.exchange,
    ).queryOrder(trade.sell.base, trade.sell.quote, sellSideSettled[1]);

    //Most exchanges support IOC, so this order will already be cancelled
    //But for those that don't, go ahead and cancel the order if unfilled.
    // getClient(trade.buy.exchange).cancelOpenOrders(trade.buy.base, trade.buy.quote);
    // getClient(trade.sell.exchange).cancelOpenOrders(trade.sell.base, trade.sell.quote);

    //Now that the orders are cancelled, let's update our balances
    //Await so we don't try any more arb before it's complete
    await getClient(trade.buy.exchange).refreshBalance();
    await getClient(trade.sell.exchange).refreshBalance();

    //
    // From here on is simply logging code. Nothing functional
    //

    var buy: TradeExecution = {
      exchange: trade.buy.exchange,
      expectedVwap: trade.buy.vwap, //this is EXPECTED vwap, not executed vwap
      expectedBase: trade.buy.volume, //EXPECTED volume
      expectedQuote: trade.buy.volume * trade.buy.vwap,
      orderId: buySideSettled[1],
      response: buySideSettled[0],
      status: buyStatus, //This object holds actual executed volumes and prices
    };

    var sell: TradeExecution = {
      exchange: trade.sell.exchange,
      expectedVwap: trade.sell.vwap,
      expectedBase: trade.sell.volume, //EXPECTED volume
      expectedQuote: trade.sell.volume * trade.sell.vwap,
      orderId: sellSideSettled[1],
      response: sellSideSettled[0],
      status: sellStatus,
    };

    var deltaBase = buy.status.executedBase - sell.status.executedBase;
    var deltaQuote = sell.status.executedQuote - buy.status.executedQuote;

    const avg_vwap = (buy.status.vwap + sell.status.vwap) / 2;
    const buy_fees =
      buy.status.fee || buy.status.executedQuote * getTradeFees(buy.exchange);
    const sell_fees =
      sell.status.fee ||
      sell.status.executedQuote * getTradeFees(sell.exchange);

    var log: ArbitrageTrade = {
      arbitrageId: arbitrageId,
      dateTime: dateString,
      idealTrade: untrimmedTrade,
      expectedTrade: trade,
      base: trade.buy.base,
      quote: trade.buy.quote,
      buy: buy,
      sell: sell,
      deltaBase: deltaBase,
      deltaQuote: deltaQuote,
      deltaBaseValue: deltaBase * avg_vwap,
      totalFees: sell_fees + buy_fees,
      estimatedDeltaValue: deltaQuote + deltaBase * avg_vwap, //DOES NOT include fees.
    };

    db.logArbitrage(log);
    debugOpportunity(trade);

    //Update the pool balance
    updatePoolBalance(
      buy.exchange,
      trade.buy.base,
      trade.buy.base,
      buy.status.executedBase,
      buy.status.vwap,
    );
    updatePoolBalance(
      buy.exchange,
      trade.buy.base,
      trade.buy.quote,
      -buy.status.executedQuote,
      buy.status.vwap,
    );
    updatePoolBalance(
      sell.exchange,
      trade.sell.base,
      trade.sell.quote,
      sell.status.executedQuote,
      sell.status.vwap,
    );
    updatePoolBalance(
      sell.exchange,
      trade.sell.base,
      trade.sell.base,
      -sell.status.executedBase,
      sell.status.vwap,
    );
    Constants.latestBaseLog[trade.buy.base].estimatedFees += log.totalFees;
    Constants.latestBaseLog[trade.buy.base].estimatedArbProfit +=
      log.estimatedDeltaValue;
    Constants.latestBaseLog[trade.buy.base].basePrice =
      (buy.expectedVwap + sell.expectedVwap) / 2;
    await db.logBase(Constants.latestBaseLog[trade.buy.base]);
  }
}

//Debugging variables
let lastAcceptedOpportunity: ArbitrageAnalysis;
var numAcceptedOpportunities = 0;

// By choice, this does not log the arb to the database
// as if the trade completed.
// In debug mode, the same opportunity may show up many many times,
// but in prod you would close the opportunity immediately.
function debugOpportunity(trade: ArbitrageAnalysis) {
  if (typeof lastAcceptedOpportunity == "undefined") {
    lastAcceptedOpportunity = trade;
  } else if (
    lastAcceptedOpportunity.buy.exchange == trade.buy.exchange &&
    lastAcceptedOpportunity.sell.exchange == trade.sell.exchange &&
    Math.abs(lastAcceptedOpportunity.buy.volume - trade.buy.volume) < 25 &&
    Math.abs(lastAcceptedOpportunity.sell.volume - trade.sell.volume) < 25
  ) {
    //Don't accept the same opportunity twice in debug mode
    return;
  } else {
    numAcceptedOpportunities++;
    lastAcceptedOpportunity = trade;
  }

  //Log the trade and profit
  var buyTrade = trade.buy.volume * trade.buy.vwap;
  var buyFees = buyTrade * getTradeFees(trade.buy.exchange);
  var sellTrade = trade.sell.volume * trade.sell.vwap;
  var sellFees = sellTrade * getTradeFees(trade.sell.exchange);
  var profit = sellTrade - buyTrade;
  var log =
    "OPPORTUNITY " +
    numAcceptedOpportunities +
    " at " +
    Date.now() +
    "\n" +
    "Bought " +
    trade.buy.volume +
    "@" +
    trade.buy.vwap +
    " on " +
    trade.buy.exchange +
    " for $" +
    trade.buy.volume * trade.buy.vwap +
    "\n" +
    "Sold " +
    trade.sell.volume +
    "@" +
    trade.sell.vwap +
    " on " +
    trade.sell.exchange +
    " for $" +
    trade.sell.volume * trade.sell.vwap +
    "\n" +
    "PROFIT: $" +
    profit +
    " - " +
    buyFees +
    " - " +
    sellFees +
    " = $" +
    (profit - buyFees - sellFees) +
    "\n" +
    "BUY:" +
    JSON.stringify(trade.buy.offers) +
    "\nSELL:" +
    JSON.stringify(trade.sell.offers) +
    "\n\n";
}

/*
 *
 *   Enact Rebalancing Trade
 *
 *
 */

// Input: TradeAnalysis for each exchange involved
// Output: True/False - Was at least 75% of this trade fulfilled?
// Post trades on every relevant exchange for the given volumes.
export async function enactRebalance(
  base: string,
  quote: string,
  side: string,
  trades: { [exch: string]: TradeAnalysis },
): Promise<boolean> {
  try {
    //Store the ID along with the exchange order IDs
    //ID is simply a timestamp so we can query trades by date
    var arbitrageId = Date.now();
    var date = new Date();
    var dateString =
      date.toLocaleDateString() +
      " " +
      date.getHours() +
      ":" +
      String(date.getMinutes()).padStart(2, "0") +
      ":" +
      String(date.getSeconds()).padStart(2, "0");

    var totalExpectedVolume = 0;
    Object.keys(trades).forEach(
      (key) => (totalExpectedVolume += trades[key].volume),
    );

    //Fire off create orders for all exchanges and save the responses
    var createOrderPromises: { [exch: string]: Promise<[{}, string]> } = {};
    for (var exch of Object.keys(trades)) {
      if (side == "BUY") {
        var finalBuyPrice =
          trades[exch].offers[trades[exch].offers.length - 1].price;
        createOrderPromises[exch] = getClient(exch).createOrder(
          trades[exch].base,
          trades[exch].quote,
          "BUY",
          "LIMIT",
          trades[exch].volume,
          finalBuyPrice,
        );
      } else {
        var finalSellPrice =
          trades[exch].offers[trades[exch].offers.length - 1].price;
        createOrderPromises[exch] = getClient(exch).createOrder(
          trades[exch].base,
          trades[exch].quote,
          "SELL",
          "LIMIT",
          trades[exch].volume,
          finalSellPrice,
        );
      }
    }

    //Wait for all promises to fulfill
    var createOrderResponses: { [exch: string]: [{}, string] } = {};
    for (var exch of Object.keys(trades)) {
      createOrderResponses[exch] = await createOrderPromises[exch];
    }

    await new Promise((r) => setTimeout(r, 1000));

    //Find out how much of each order filled
    var totalFilledVolume = 0;
    var tradeStatuses: { [exch: string]: OrderStatus } = {};
    for (var exch of Object.keys(trades)) {
      tradeStatuses[exch] = await getClient(exch).queryOrder(
        trades[exch].base,
        trades[exch].quote,
        createOrderResponses[exch][1],
      );
      totalFilledVolume += tradeStatuses[exch].executedBase;
    }

    //Most exchanges support IOC, so this order will already be cancelled
    //But for those that don't, go ahead and cancel the order if unfilled.
    for (var exch of Object.keys(trades)) {
      getClient(exch).cancelOpenOrders(trades[exch].base, trades[exch].quote);
    }

    //Now that the orders are cancelled, let's update our balances
    for (var exch of Object.keys(trades)) {
      await getClient(exch).refreshBalance();
    }

    //
    // Now handle logging
    //

    var postedTrades: TradeExecution[] = Array();
    for (var exch of Object.keys(trades)) {
      postedTrades.push({
        exchange: exch,
        expectedVwap: trades[exch].vwap,
        expectedBase: trades[exch].volume, //EXPECTED volume
        expectedQuote: trades[exch].volume * trades[exch].vwap,
        orderId: createOrderResponses[exch][1],
        response: createOrderResponses[exch][0],
        status: tradeStatuses[exch], //This object holds actual executed volumes and prices
      });
    }

    var deltaBase = 0;
    var deltaQuote = 0;
    var baseMultiplier = side == "BUY" ? 1 : -1;
    var quoteMultiplier = side == "BUY" ? -1 : 1;
    let price_times_volume = 0;
    let total_vol = 0;
    let total_fee = 0;
    for (var exch of Object.keys(trades)) {
      deltaBase += baseMultiplier * tradeStatuses[exch].executedBase;
      deltaQuote += quoteMultiplier * tradeStatuses[exch].executedQuote;
      price_times_volume +=
        tradeStatuses[exch].vwap * tradeStatuses[exch].executedBase;
      total_vol += tradeStatuses[exch].executedBase;
      total_fee +=
        tradeStatuses[exch].fee ||
        tradeStatuses[exch].executedQuote * getTradeFees(exch);
    }

    let vwvwap = price_times_volume / total_vol;

    var expectedTrades: TradeAnalysis[] = Array();
    for (var exch of Object.keys(trades)) {
      expectedTrades.push(trades[exch]);
    }

    var log: RebalanceTrade = {
      tradeId: arbitrageId,
      dateTime: dateString,
      expectedTrade: expectedTrades,
      base: base,
      quote: quote,
      side: side,
      orders: postedTrades,
      deltaBase: deltaBase,
      deltaBaseValue: deltaBase * vwvwap,
      deltaQuote: deltaQuote,
      vwap: vwvwap,
      executedVolume: deltaBase,
      totalFees: total_fee,
    };

    db.logRebalance(log);

    //Get all new exchange balances for this asset, after rebalance
    const exchangeBalances: { [exch: string]: ExchangeBalance } = {};
    Constants.exchanges.forEach(
      (exch) =>
        (exchangeBalances[exch] = {
          exchange: exch,
          quote: 0,
          base: 0,
          baseValue: 0,
          exchangePrice: getExchangePrice(exch, base),
        }),
    );
    await Promise.all(
      Constants.exchanges
        .map((exch) =>
          getBalance(exch, base).then(
            (resp) => (exchangeBalances[exch].base = resp),
          ),
        )
        .concat(
          Constants.exchanges.map((exch) =>
            getBalance(exch, "USDT").then(
              (resp) => (exchangeBalances[exch].quote = resp),
            ),
          ),
        ),
    );
    Constants.exchanges.forEach(
      (exch) =>
        (exchangeBalances[exch].baseValue =
          exchangeBalances[exch].base * exchangeBalances[exch].exchangePrice),
    );

    //Update base log
    let latestBaseLog = Constants.latestBaseLog[base];
    var baselog: BaseLog = {
      timestamp: arbitrageId,
      dateTime: dateString,
      base: base,
      quote: quote,
      initialInvestment: latestBaseLog.initialInvestment,
      initialInvestmentVwap: latestBaseLog.initialInvestmentVwap,
      sumQuote: (latestBaseLog.sumQuote + deltaQuote )|| 0,
      sumBase: (latestBaseLog.sumBase + deltaBase) || 0,
      sumBaseValue: ((latestBaseLog.sumBase + deltaBase) * vwvwap) || 0,
      basePrice: vwvwap,
      exchangeBalances,
      lastRebalanceTs: arbitrageId,
      lastRebalancePrice: vwvwap,
      estimatedArbProfit: latestBaseLog.estimatedArbProfit,
      estimatedRebalanceProfit:
        latestBaseLog.estimatedRebalanceProfit +
        deltaQuote +
        deltaBase * vwvwap,
      estimatedFees: latestBaseLog.estimatedFees + total_fee,
    };

    Constants.latestBaseLog[base] = baselog;
    db.logBase(baselog);

    //Was at least 40% of this rebalance filled?
    return totalFilledVolume >= totalExpectedVolume * 0.4;
  } catch (e) {
    console.error(
      "[EnactRebalance][ERROR] Caught error building rebalance trade: ",
      e,
    );
    return false;
  }
}
