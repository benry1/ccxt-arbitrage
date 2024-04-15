import { getOrderbooks, getTradeFees } from "../controller/exchangeController";
import { Constants } from "./constants";
import {
  TradeAnalysis,
  Ask,
  Bid,
  Orderbook,
  SingleAssetArbitrage,
  ArbitrageAnalysis,
} from "../interfaces";
import { getPoolBalance } from "../controller/PoolController";

/*
 *   Given an arb opportunity, get the relevant orderbooks, and calculate the volume to trade on each exchange.
 *   Input: Pair, buyExchange, sellExchange
 *   Output: ArbitrageAnalysis - list of trades to make and profit to expect
 *
 *   Algo Description
 *   Consume the first bid or ask. While trying to keep our buy/sell volume the same,
 *   continue filling bid/asks until the prices are within 0.01% of each other.
 *   Finally, equalize the volumes by removing volume from the final trade we add.
 */
export function analyzeOpportunity(
  opportunity: SingleAssetArbitrage,
): ArbitrageAnalysis {
  try {
    var buyOrderbook = JSON.parse(
      JSON.stringify(getOrderbooks(opportunity.base)[opportunity.buyOn]),
    );
    var sellOrderbook = JSON.parse(
      JSON.stringify(getOrderbooks(opportunity.base)[opportunity.sellOn]),
    );
    // console.log("Asks from ", opportunity.buy.exchange, ":", JSON.stringify(buyOrderbook.asks.slice(0,3)))
    // console.log("Bids from ", opportunity.sell.exchange, ":", JSON.stringify(sellOrderbook.bids.slice(0,3)))

    //Keep track of all orders we will place (return value)
    var buyOffersToPost: Bid[] = Array();
    var sellOffersToPost: Ask[] = Array();

    var thisAsk = buyOrderbook.asks.shift()!;
    var thisBid = sellOrderbook.bids.shift()!;

    // console.log("Initial Bid/Ask", JSON.stringify(thisBid), JSON.stringify(thisAsk))

    var buyVolume = 0; //(thisAsk.volume)
    var sellVolume = 0; //(thisBid.volume)
    thisAsk.volume < thisBid.volume
      ? (buyVolume = thisAsk.volume)
      : (sellVolume = thisBid.volume);

    //Keep track of how much volume is needed to fill the rest of the order on the other exchange
    var remainingInAsk = Math.max(0, thisAsk.volume - thisBid.volume);
    var remainingInBid = Math.max(0, thisBid.volume - thisAsk.volume);

    //We know we want the top level bid and ask. Whichever one is smaller, add it to our known offers
    if (remainingInAsk > 0) {
      sellOffersToPost.push(thisBid);
      thisBid = sellOrderbook.bids.shift()!;
    } else {
      buyOffersToPost.push(thisAsk);
      thisAsk = buyOrderbook.asks.shift()!;
    }

    var settledAskPrice = thisAsk.price;
    var settledBidPrice = thisBid.price;

    //While the prices have not converged
    while (
      settledAskPrice <= settledBidPrice * 0.999 &&
      buyOrderbook.asks.length > 0 &&
      sellOrderbook.bids.length > 0
    ) {
      // console.log("Bid/Ask", JSON.stringify(thisBid), JSON.stringify(thisAsk))
      // console.log("Bid/Ask Remaining ", remainingInBid, remainingInAsk)
      // console.log("sell/buy Tot Vol   ", sellVolume, buy.volume)

      //If there is sill volume left in bid, we need a new ask. Or vice versa
      if (remainingInBid > 0) {
        thisAsk = buyOrderbook.asks.shift()!;
        settledAskPrice = thisAsk.price;
        remainingInBid -= thisAsk.volume; //Subtract this ask volume from remaining volume in bid
        //If this ask ate up all the volume left up in the bid, do bookkeeping
        if (remainingInBid < 0) {
          remainingInAsk = Math.abs(remainingInBid);
          remainingInBid = 0;
          //This bid is filled, we know we will sell the full amount
          sellOffersToPost.push(thisBid);
          sellVolume += thisBid.volume;
        } else {
          //The ask was filled, but bid still has volume left.
          buyOffersToPost.push(thisAsk);
          buyVolume += thisAsk.volume;
        }
      } else {
        thisBid = sellOrderbook.bids.shift()!;
        settledBidPrice = thisBid.price;
        remainingInAsk -= thisBid.volume;
        if (remainingInAsk < 0) {
          remainingInBid = Math.abs(remainingInAsk);
          remainingInAsk = 0;
          //This ask is filled, we know we will buy the full amount
          buyOffersToPost.push(thisAsk);
          buyVolume += thisAsk.volume;
        } else {
          //The bid was filled, but ask still has volume left.
          sellOffersToPost.push(thisBid);
          sellVolume += thisBid.volume;
        }
      }
    }

    //This is an edge case
    //If at least one order on both BUY/SELL side is not fulfilled,
    //Then this will break.
    //If we have 0 filled buy orders, create a single partial buy order
    if (buyOffersToPost.length == 0 && sellOffersToPost.length > 0) {
      buyOffersToPost.push({ price: thisAsk.price, volume: sellVolume });
      buyVolume += sellVolume;
    } else if (sellOffersToPost.length == 0 && buyOffersToPost.length > 0) {
      sellOffersToPost.push({ price: thisBid.price, volume: buyVolume });
      sellVolume += buyVolume;
    }

    // console.log("Pre-pruning Buy/Sell")
    // console.log(buyOffersToPost)
    // console.log(sellOffersToPost)

    //Equalize volumes
    //Remove volume from the larger side until it equals the smaller side.
    var volumeDiff = buyVolume - sellVolume;
    if (volumeDiff > 0) {
      //Remove some volume from buy side
      while (buyVolume - sellVolume > 0) {
        var finalBuy = buyOffersToPost[buyOffersToPost.length - 1];
        if (finalBuy.volume - Math.abs(volumeDiff) < 0) {
          //The last buy order doesn't ahve enough volume to equalize the volumes.
          //Remove this buy entirely, and update the volume data
          // console.log("Remvoing because last buy has vol ", finalBuy.volume, " and the volume difference is ", volumeDiff)
          buyVolume -= finalBuy.volume;
          volumeDiff = buyVolume - sellVolume;
          buyOffersToPost.pop();
        } else {
          //The last buy order is large enough to equalise volumes.
          // console.log("Lowering buy volume because last buy has vol ", finalBuy.volume, " and the volume difference is ", volumeDiff)
          buyOffersToPost[buyOffersToPost.length - 1] = {
            price: finalBuy.price,
            volume: finalBuy.volume - Math.abs(volumeDiff),
          };
          buyVolume -= Math.abs(volumeDiff);
          break;
        }
      }
    } else if (volumeDiff < 0) {
      //Remove some volume form last sell to equalize
      while (buyVolume - sellVolume < 0) {
        var finalSell = sellOffersToPost[sellOffersToPost.length - 1];
        if (finalSell.volume - Math.abs(volumeDiff) < 0) {
          // console.log("Remvoing because last sell has vol ", finalSell.volume, " and the volume difference is ", volumeDiff)
          //Last sell doesn't have enough volume to equalize.
          //Remove it and update volume data
          sellVolume -= finalSell.volume;
          volumeDiff = buyVolume - sellVolume;
          sellOffersToPost.pop();
        } else {
          // console.log("Lowering sell volume because last sell has vol ", finalSell.volume, " and the volume difference is ", volumeDiff)
          sellOffersToPost[sellOffersToPost.length - 1] = {
            price: finalSell.price,
            volume: finalSell.volume - Math.abs(volumeDiff),
          };
          sellVolume -= Math.abs(volumeDiff);
          break;
        }
      }
    }

    // console.log("Buy/Sell Volumes: ", buyVolume, sellVolume)
    // console.log("HBid/LAsk Final Price: ", settledBidPrice, settledAskPrice)
    // console.log("Buy Orders", JSON.stringify(buyOffersToPost), JSON.stringify(sellOffersToPost))

    //Now calculate profit
    var [buyVwap, sellVwap, buyOrderVolume, sellOrderVolume] = vwap({
      exchange: "",
      asks: sellOffersToPost,
      bids: buyOffersToPost,
      base: opportunity.base,
      quote: opportunity.quote,
      timestamp: Date.now(),
      datetime: "",
    });
    var boughtValue = buyVwap * buyOrderVolume;
    var soldValue = sellVwap * sellOrderVolume;
    console.log(
      "[ANALYSIS][",
      opportunity.base,
      "] Optimal Buy: ",
      buyOrderVolume.toFixed(4),
      "@",
      boughtValue.toFixed(4),
      "on",
      opportunity.buyOn,
      "Optimal Sell: ",
      sellOrderVolume.toFixed(4),
      "@",
      soldValue,
      "on",
      opportunity.sellOn,
      "Ratio: ",
      (soldValue / boughtValue).toFixed(4),
    );

    if (Math.abs(buyOrderVolume - sellOrderVolume) > 0.1) {
      console.error("[ERROR][ALERT] Imbalanced buy/sell volume!");
    }
    const empty_analysis: TradeAnalysis = {
      volume: 0,
      vwap: 0,
      offers: [],
      exchange: "",
      side: "",
      base: opportunity.base,
      quote: opportunity.quote,
      orderbookTS: 0,
    };
    return {
      buy: {
        side: "BUY",
        exchange: opportunity.buyOn,
        base: opportunity.base,
        quote: opportunity.quote,
        volume: buyOrderVolume,
        vwap: buyVwap,
        offers: buyOffersToPost,
        orderbookTS: buyOrderbook.timestamp,
      },
      sell: {
        side: "SELL",
        exchange: opportunity.sellOn,
        base: opportunity.base,
        quote: opportunity.quote,
        volume: sellOrderVolume,
        vwap: sellVwap,
        offers: sellOffersToPost,
        orderbookTS: sellOrderbook.timestamp,
      },
      idealProfit: soldValue - boughtValue,
    };
  } catch (e) {
    console.error("[ANALYSIS][ERROR]:", e, JSON.stringify(opportunity));
    const empty_analysis: TradeAnalysis = {
      volume: 0,
      vwap: 0,
      offers: [],
      exchange: "",
      side: "",
      base: opportunity.base,
      quote: opportunity.quote,
      orderbookTS: 0,
    };
    return {
      buy: {
        ...empty_analysis,
        side: "BUY",
        exchange: opportunity.sellOn,
      },
      sell: {
        ...empty_analysis,
        side: "SELL",
        exchange: opportunity.sellOn,
      },
      idealProfit: 0,
    };
  }
}

export function trimToBalance(_analysis: ArbitrageAnalysis): ArbitrageAnalysis {
  try {
    var analysis: ArbitrageAnalysis = JSON.parse(JSON.stringify(_analysis));
    if (!Constants.debug) {
      // console.log("Trimming opportunity to available balance...")
      //Need to know our USDT balance in terms of Exfi, because all orders deal with exfi volume
      var usdtBalance =
        (getPoolBalance(analysis.buy.base, "USDT", analysis.buy.exchange)
          .actual /
          analysis.buy.offers[analysis.buy.offers.length - 1].price) *
        0.99;
      var baseBalance =
        getPoolBalance(
          analysis.sell.base,
          analysis.sell.base,
          analysis.sell.exchange,
        ).actual * 0.99;

      //           console.log(JSON.stringify(analysis.buy)); console.log(JSON.stringify(analysis.sell))
      //		 console.log("To $", usdtBalance, " and ", baseBalance)
      //	console.log("USDT on", analysis.buy.exchange, await db.getPoolBalance(analysis.buy.base, "USDT", analysis.buy.exchange))
      //       console.log("Base on", analysis.sell.exchange, await db.getPoolBalance(analysis.sell.base, analysis.sell.base, analysis.sell.exchange))
      //Limit the order, so the trade on each side is only as large as our smallest balance
      var minBalance = Math.min(usdtBalance, baseBalance);
      while (analysis.buy.volume > minBalance) {
        var finalBuy = analysis.buy.offers[analysis.buy.offers.length - 1];
        //If the last trade is large enough to equalize, then do that. Otherwise, remove the last trade
        if (analysis.buy.volume - minBalance <= finalBuy.volume) {
          analysis.buy.offers[analysis.buy.offers.length - 1].volume =
            finalBuy.volume - (analysis.buy.volume - minBalance);
          analysis.buy.volume -= analysis.buy.volume - minBalance;
        } else {
          analysis.buy.volume -= finalBuy.volume;
          analysis.buy.volume = analysis.buy.volume; //JS precision errors are a pain in the ass
          analysis.buy.offers.pop();
        }
      }
      while (analysis.sell.volume > minBalance) {
        var finalSell = analysis.sell.offers[analysis.sell.offers.length - 1];
        if (analysis.sell.volume - minBalance <= finalSell.volume) {
          analysis.sell.offers[analysis.sell.offers.length - 1].volume =
            finalSell.volume - (analysis.sell.volume - minBalance);
          analysis.sell.volume -= analysis.sell.volume - minBalance;
        } else {
          analysis.sell.volume -= finalSell.volume;
          analysis.sell.volume = analysis.sell.volume;
          analysis.sell.offers.pop();
        }
      }
    }
    //Calculate actual profit after all trimming
    var [buyVwap, sellVwap, buyOrderVolume, sellOrderVolume] = vwap({
      exchange: "",
      asks: analysis.sell.offers,
      bids: analysis.buy.offers,
      base: analysis.buy.base,
      quote: analysis.buy.quote,
      timestamp: Date.now(),
      datetime: "",
    });
    var boughtValue = buyVwap * buyOrderVolume;
    var soldValue = sellVwap * sellOrderVolume;
    console.info(
      "[TRIMMED] Buying: ",
      buyOrderVolume,
      " for $",
      boughtValue,
      " Selling: ",
      sellOrderVolume,
      " for $",
      soldValue,
      " Profit Ratio: ",
      soldValue / boughtValue,
    );
    analysis.idealProfit =
      soldValue -
      boughtValue -
      getTradeFees(analysis.sell.exchange) * soldValue -
      getTradeFees(analysis.buy.exchange) * boughtValue;
    return analysis;
  } catch (e) {
    console.error("[TRIMMING][ERROR]:", e);
    return _analysis;
  }
}

//VWAP Over all buys/sells about to post. Return BUY/SELL vwap
function vwap(ob: Orderbook): [number, number, number, number] {
  var volumes: [number, number] = [0, 0];
  var vwaps: [number, number] = [0, 0];

  ob.bids.forEach((bid) => {
    volumes[0] += bid.volume;
    var tradeWeight = bid.volume / volumes[0];
    vwaps[0] = vwaps[0] * (1 - tradeWeight) + bid.price * tradeWeight;
  });
  ob.asks.forEach((ask) => {
    volumes[1] += ask.volume;
    var tradeWeight = ask.volume / volumes[1];
    vwaps[1] = vwaps[1] * (1 - tradeWeight) + ask.price * tradeWeight;
  });
  return [...vwaps, ...volumes];
}

/*
 *  Take all orderbooks. Return two lists:
 *  One sorted by lowest ask. One sorted by highest bid.
 *  So the first of each list shows the best arb opportunity
 *  Input: KV of all orderbooks
 *  Otuput: [List of orderbooks by lowest bid, List of orderbooks by highest ask]
 */
export function sortOrderbooks(orderbooks: {
  [exch: string]: Orderbook;
}): [Orderbook[], Orderbook[]] {
  var sortedByAsk: Orderbook[] = Array();
  var sortedByBid: Orderbook[] = Array();

  for (const [exchange, ob] of Object.entries(orderbooks)) {
    if (
      !ob ||
      !ob.asks ||
      ob.asks.length == 0 ||
      !ob.bids ||
      ob.bids.length == 0
    ) {
      continue;
    }
    sortedByAsk.push(ob);
    sortedByBid.push(ob);
  }

  sortedByAsk.sort(sortAsksAscending);
  sortedByBid.sort(sortBidsDescending);

  return [sortedByBid, sortedByAsk];
}

function sortAsksAscending(a: Orderbook, b: Orderbook): number {
  if (a.asks[0].price < b.asks[0].price) {
    return -1;
  } else if (a.asks[0].price > b.asks[0].price) {
    return 1;
  } else {
    return 0;
  }
}

function sortBidsDescending(a: Orderbook, b: Orderbook): number {
  if (a.bids[0].price > b.bids[0].price) {
    return -1;
  } else if (a.bids[0].price < b.bids[0].price) {
    return 1;
  } else {
    return 0;
  }
}
