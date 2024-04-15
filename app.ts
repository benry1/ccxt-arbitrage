async function sleep(timeout: number) { await new Promise(f => setTimeout(f, timeout)); }
import { deleteOrderbook, getOrderbooks, getTradeFees, initializeExchanges, refreshOrderbooks } from "./controller/exchangeController";
import { db } from "./db";
import { Constants } from "./util/constants";
import { ArbitrageAnalysis, Orderbook } from "./interfaces"
import { analyzeOpportunity, sortOrderbooks, trimToBalance } from "./util/orderbook";
import { buildRebalancingTrade, determineRebalanceAmount, getFairPrice } from "./util/state";
import { enactOpportunity, enactRebalance } from "./controller/TradeController";
import { getPoolBalance, initializePools } from "./controller/PoolController";

/*
* Arbitrage algorithm goes here. Each tick, check for new arb opportunities
* Input: None
* Output: None
* Description: Gather newest prices. Search for arb opportunity.
*   When one is found, build SingleAssetArbitrage object. Pass this to
*   orderbook calculator, which will calculate volumes to trade.
*/
async function tick(base: string) {
    try {
        console.info(`Ticking ${base}`)
        //Gather and sort valid orderbooks
        var orderBooks: { [exch: string]: Orderbook } = getOrderbooks(base)
        if (Object.keys(orderBooks).length < 2) {
            console.info("Not enough orderbooks to arbitrage yet", base)
            return
        }
        //Copy the orderbooks. Sort by lowest bid and highest ask
        var [sortedByBid, sortedByAsk] = sortOrderbooks(orderBooks)

        //Find all useful arbitrages
        var allActionableThisTick: ArbitrageAnalysis[] = Array()
        const empty = {
            base: "",
            quote: "",
            exchange: "",
            side: "",
            volume: 0,
            vwap: 0,
            orderbookTS: 0,
            offers: []
        }
        var bestProfitTrimmed: ArbitrageAnalysis = {
            buy: { ...empty },
            sell: { ...empty },
            idealProfit: 0
        }
        var bestProfitRaw: ArbitrageAnalysis = { ...bestProfitTrimmed }

        //Go through every ask 
        for (var askbook of sortedByAsk) {
            var bidIndex = 0;
            var askPrice = askbook.asks[0].price
            //For any bid that is 0.5% more than this ask, check the spread.
            while ((sortedByBid[bidIndex].bids[0].price - askPrice) / sortedByBid[bidIndex].bids[0].price >= 0.005) {
                var checkOpportunity = {
                    base: base,
                    quote: "USDT",
                    buyOn: askbook.exchange,
                    sellOn: sortedByBid[bidIndex].exchange
                }

                var analysis: ArbitrageAnalysis = analyzeOpportunity(checkOpportunity)
                var trimmed: ArbitrageAnalysis = trimToBalance(analysis)
                var actionable = isActionable(trimmed)
                if (actionable) {
                    allActionableThisTick.push(trimmed)
                    if (bestProfitTrimmed.idealProfit < trimmed.idealProfit) {
                        bestProfitTrimmed = trimmed
                        bestProfitRaw = analysis
                    }
                }

                bidIndex++
            }
        }
        // console.debug(askPrice, sortedByAsk[0].asks[0].price, sortedByBid[0].bids[0].price)
        console.debug("Found", allActionableThisTick.length, "opportunities this tick. Best spread was", ((sortedByBid[0].bids[0].price - sortedByAsk[0].asks[0].price) / sortedByBid[0].bids[0].price).toFixed(4))
        console.info("Buying: ", bestProfitTrimmed.buy.volume.toFixed(5), "@", bestProfitTrimmed.buy.vwap.toFixed(4), "on", bestProfitTrimmed.buy.exchange, " Selling: ", bestProfitTrimmed.sell.volume, "@", bestProfitTrimmed.sell.vwap.toFixed(4), "on", bestProfitTrimmed.sell.exchange, " Profit: ", bestProfitTrimmed.idealProfit.toFixed(2))


        //If there were any valid opportunities, enact the best one
        if (bestProfitTrimmed.idealProfit > 0) {
            //Do Not reuse orderbooks after arbing it!
            deleteOrderbook(bestProfitTrimmed.buy.exchange, bestProfitTrimmed.buy.base)
            deleteOrderbook(bestProfitTrimmed.sell.exchange, bestProfitTrimmed.sell.base)
            await enactOpportunity(bestProfitTrimmed, bestProfitRaw)
        }

        console.info("\n")
    } catch (e) { console.error("[APP][ERROR] Abandoned tick:", e) }

}

async function check_rebalance(base: string) {
    var fairPrice = getFairPrice(base)
    var lastBaseLog = Constants.latestBaseLog[base]
    if (!lastBaseLog) { return }
    var pctChange = Math.abs((fairPrice - lastBaseLog.lastRebalancePrice) / ((fairPrice + lastBaseLog.lastRebalancePrice) / 2))

    //Rebalance wallets every 4 hours, on large price swings, or just if we are lopsided
    const prod = !Constants.debug
    const notRebalancedRecently = (Date.now() - lastBaseLog.lastRebalanceTs > 4 * Constants.oneHour)
    const priceChangedALot = pctChange > 0.05
    const largerVal = Math.max((getPoolBalance(base, base)).value, (getPoolBalance(base, "USDT")).value)
    const smallerVal = Math.min((getPoolBalance(base, base)).value, (getPoolBalance(base, "USDT")).value)
    const veryLopsidedBalances = smallerVal * 3 < largerVal
    if (!prod) return
    if (notRebalancedRecently || priceChangedALot || veryLopsidedBalances) {
        const result = await try_rebalance(base, fairPrice)
        if (result) {
            console.info(`Finished rebalance. Inserted new ${base} base log.`)
        }
    }
}
async function try_rebalance(base: string, fairPrice: number) {
    try {
        var rebalanceFulfilled = false
        let tries = 0
        //If our trades fail, try rebalancing again until complete.
        while (!rebalanceFulfilled && tries < 5) {
            tries++
            //Check if rebalance is needed
            var detect = await determineRebalanceAmount(base)
            if (detect.amount > 0) {
                //Build our rebalance if requested
                var trades = await buildRebalancingTrade(detect)
                rebalanceFulfilled = await enactRebalance(base, "USDT", detect.side, trades)
                await refreshOrderbooks() //If this fails, we need to know the new updated orders that will actually work
            } else {
                rebalanceFulfilled = true
            }
        }
        return {
            lastRebalance: Date.now(),
            lastRebalancePrice: fairPrice
        }


    } catch (e) { console.error("[ERROR] Abandoned rebalance trade because:", e) }
}

async function main() {
    console.info("Initializing...")
    console.info("Debug mode:", Constants.debug)

    //Initialize
    //Get exchange balances, initialize state
    await initializeExchanges()
    await Constants.initializeCache()
    await initializePools()
    await sleep(500)

    while (true) {
        let a = Date.now()
        //Request new orderbooks for every exchange.
        //As soon as each exchange returns an orderbook, "tick" (check for arbitrages)
        await Promise.all(refreshOrderbooks().map(promise => promise.then(done => Constants.symbols.map(base => tick(base)))))
        let b = Date.now()

        console.debug(`Full Tick time: ${b - a}ms`)
        //Wait 1.7s for next tick
        await sleep(2000)
        let d = Date.now()

        //Failed arbitrages can make it so our holdings are lopsided. Check for rebalance
        await Promise.all(Constants.symbols.map(base => check_rebalance(base)))
    }
}

function isActionable(trade: ArbitrageAnalysis): boolean {
    try {
        //This happened once. I dont know why. Let's just check it.
        var uniqueExchanges = trade.buy.exchange !== trade.sell.exchange

        //Willing to make %0.5 per trade after fees
        var acceptableRatio = trade.sell.vwap / trade.buy.vwap - 1 > getTradeFees(trade.buy.exchange) + getTradeFees(trade.sell.exchange) + 0.005

        //Must have enough balance for the trade
        var sellBalance = (getPoolBalance(trade.sell.base, trade.sell.base, trade.sell.exchange)).actual
        var buyBalance = (getPoolBalance(trade.buy.base, "USDT", trade.buy.exchange)).actual / trade.buy.offers[0].price
        var sufficientBuyBalance = trade.buy.volume < buyBalance
        var sufficientSellBalance = trade.sell.volume < sellBalance

        //Most exchanges have a minimum 10USD trade limit - only trade for $11 or more to be safe
        var sufficientVolume = trade.buy.volume * trade.buy.offers[0].price > 11

        //Orderbooks should be current
        var acceptableInformation = Date.now() - trade.buy.orderbookTS < 4000 && Date.now() - trade.sell.orderbookTS < 4000

        if (!acceptableInformation) {
            console.info("[ALERT] Found actionable opportunity, but orderbook is not current: ", Date.now() - trade.buy.orderbookTS, Date.now() - trade.sell.orderbookTS)
        }

        if (!sufficientBuyBalance && !Constants.debug) {
            console.info("[ALERT] Found arb opportunity, but insufficient buy balance on ", trade.buy.exchange, "of", trade.buy.volume)
        }

        if (!sufficientSellBalance && !Constants.debug) {
            console.info("[ALERT] Found arb opportunity, but insufficient sell balance on ", trade.sell.exchange, "of", sellBalance)
        }

        if (!sufficientVolume) {
            console.info("[ALERT] Found arb opportunity, but insufficient volume of ~$", trade.buy.volume * trade.buy.offers[0].price)
        }

        if (!acceptableRatio) {
            console.info('[ALERT] Opportunity is not worth it after fees.')
        }

        if (!uniqueExchanges) {
            console.info('[ALERT] This opportunity is on the same exchange..?')
        }

        //Let's ignore balances for debug mode.
        if (Constants.debug) {
            return uniqueExchanges && acceptableRatio && acceptableInformation
        } else {
            return uniqueExchanges && acceptableRatio && sufficientBuyBalance && sufficientSellBalance && acceptableInformation && sufficientVolume
        }
    } catch (e) { return false }
}

main()
