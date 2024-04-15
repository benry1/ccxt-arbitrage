/************************************************************************
 * 
 * Running arbitrage on X requires holding X and USD on all exchanges.
 * If you are running arb on more than one asset, you need to know how
 * much USD is allocated to asset X and how much is allocated to asset Y.
 * Otherwise race conditions could cause you to overspend or overbuy.
 * 
 * This is the purpose of the PoolController. It keeps track of how much
 * of each asset is on each exchange. It also keeps track of how much of
 * that exchange's USD is allocated to each asset.
 * 
 *************************************************************************/
import { db } from "../db";
import { CachedPoolS, CachedExchangeBalances } from "../interfaces";
import { Constants } from "../util/constants";
import {
  getAllBalances,
  getClient,
  getExchangePrice,
} from "./exchangeController";

//Updates to the pools happen in the Cache,
//At the end of the function the cache is committed to db
export async function initializePools() {
  const pools = await getPools();
  const expected_balances = getExpectedBalances(pools);
  const true_balances = await getAllBalances();
  console.info("Pools: ", JSON.stringify(pools));
  console.info("Expected from Pools:", JSON.stringify(expected_balances));
  console.info("True Balances: ", JSON.stringify(true_balances));

  initializeExchangeBalances();

  //If we found more assets than we expected from last time,
  //we need to add them to the pool. This handles capital additions.
  for (const exch of Constants.exchanges) {
    //Handle additional base being added
    for (const base of Constants.symbols) {
      if (
        !closeEnough(expected_balances[exch][base], true_balances[exch][base])
      ) {
        const fairPrice = getExchangePrice(exch, base);
        const baseAdded =
          true_balances[exch][base] - expected_balances[exch][base];
        //Handle BaseExch Capital Addition
        updateInitialInvestmentInfo(base, fairPrice, baseAdded * fairPrice);
        updatePoolBalance(exch, base, base, baseAdded, fairPrice);
      } else {
        console.debug(`${base} on ${exch} looks even - no rebalance needed`);
      }
    }
    //Handle additional quote being added
    for (const quote of Constants.stableSymbols) {
      if (
        !closeEnough(expected_balances[exch][quote], true_balances[exch][quote])
      ) {
        const quoteAdded =
          true_balances[exch][quote] - expected_balances[exch][quote];
        //We have gained or lost quote. Distribute it among all valid markets
        const numMarkets = Constants.symbols
          .map((sym) => getClient(exch).hasMarket(sym, quote))
          .reduce((a, b) => a + (b ? 1 : 0), 0);
        for (const base of Constants.symbols) {
          if (getClient(exch).hasMarket(base, quote)) {
            const fairPrice = getExchangePrice(exch, base);
            updateInitialInvestmentInfo(
              base,
              fairPrice,
              quoteAdded / numMarkets,
            );
            updatePoolBalance(
              exch,
              base,
              quote,
              quoteAdded / numMarkets,
              fairPrice,
            );
          }
        }
      } else {
        console.debug(`${quote} on ${exch} looks even - no rebalancing needed`);
      }
    }
  }

  console.debug("Latest Base Log:", JSON.stringify(Constants.latestBaseLog));
  await Promise.all(
    Constants.symbols.map((base) => db.logBase(Constants.latestBaseLog[base])),
  );
}

function updateInitialInvestmentInfo(
  base: string,
  fairPrice: number,
  quoteValue: number,
) {
  const old_init = Constants.latestBaseLog[base].initialInvestment;
  const old_vwap = Constants.latestBaseLog[base].initialInvestmentVwap;

  const numerator = old_init + quoteValue;
  const denominator = (old_init / old_vwap || 0) + quoteValue / fairPrice;

  if (!isNaN(old_init + quoteValue)) {
    Constants.latestBaseLog[base].initialInvestment = old_init + quoteValue;
  } else {
    Constants.latestBaseLog[base].initialInvestment = 0;
  }

  if (!isNaN(numerator / denominator)) {
    Constants.latestBaseLog[base].initialInvestmentVwap = numerator / denominator;
  } else {
    Constants.latestBaseLog[base].initialInvestmentVwap = 0;
  }
}

//This assumes that exchangeBalances are populated correctly
export function updatePoolBalance(
  exch: string,
  pool: string,
  asset: string,
  amount: number,
  fairPrice: number = 1,
) {
  const isBase = pool == asset;
  const type = isBase ? "base" : "quote";
  if (type == "quote") {
    //Rollup stat
    Constants.latestBaseLog[pool].sumQuote += (amount || 0);
    //exchange-specific
    Constants.latestBaseLog[pool].exchangeBalances[exch].quote += (amount || 0);
    Constants.latestBaseLog[pool].exchangeBalances[exch].exchangePrice =
      fairPrice;
  } else {
    //Rollup stats
    Constants.latestBaseLog[pool].sumBase += (amount || 0);
    Constants.latestBaseLog[pool].sumBaseValue =
      (Constants.latestBaseLog[pool].sumBase * fairPrice || 0);
    //Exchange specific
    Constants.latestBaseLog[pool].exchangeBalances[exch].base += (amount || 0);
    Constants.latestBaseLog[pool].exchangeBalances[exch].baseValue =
      (Constants.latestBaseLog[pool].exchangeBalances[exch].base * fairPrice || 0);
    Constants.latestBaseLog[pool].exchangeBalances[exch].exchangePrice =
      fairPrice;
  }
}

//Given the pool data, how much of each asset
//is expected on each exchange?
function getExpectedBalances(pool: CachedPoolS): CachedExchangeBalances {
  const expected: CachedExchangeBalances = {};

  //Initialize the object
  Constants.exchanges.forEach((exch) => {
    expected[exch] = {};
    Constants.symbols.forEach((base) => {
      expected[exch][base] = 0;
    });
    Constants.stableSymbols.forEach((quote) => {
      expected[exch][quote] = 0;
    });
  });
  console.debug(`Initial Balances: ${JSON.stringify(expected)}`);

  //Do the rollup
  Constants.exchanges.forEach((exch) => {
    Constants.symbols.forEach((base) => {
      Constants.stableSymbols.concat(base).forEach((asset) => {
        expected[exch][asset] += pool[base][exch][asset];
      });
    });
  });

  return expected;
}

function initializeExchangeBalances() {
  Constants.symbols.forEach((base) => {
    Constants.exchanges.forEach((exchange) => {
      if (getClient(exchange).hasMarket(base, "USDT")) {
        if (!Constants.latestBaseLog[base].exchangeBalances[exchange]) {
          Constants.latestBaseLog[base].exchangeBalances[exchange] = {
            exchange,
            base: 0,
            baseValue: 0,
            quote: 0,
            exchangePrice: 1,
          };
        }
      }
    });
  });
}

async function getPools(): Promise<CachedPoolS> {
  const pools: CachedPoolS = {};
  for (const base of Constants.symbols) {
    pools[base] = {};
    //Get pool balances for every symbol
    for (const exch of Constants.exchanges) {
      pools[base][exch] = {};
      pools[base][exch][base] = getPoolBalance(base, base, exch).actual;
      pools[base][exch]["USDT"] = getPoolBalance(base, "USDT", exch).actual;
    }
  }
  return pools;
}

//Gets the total available balance of an asset
//If exchange is set, then will only return the pool balance for that exchange
export function getPoolBalance(
  base: string,
  asset: string,
  exch?: string,
): { actual: number; value: number } {
  const ret = { actual: 0, value: 0 };
  //Can only request base or quote
  const isBase = base == asset;
  const act = isBase ? "base" : "quote";
  const val = isBase ? "baseValue" : "quote";
  const baseLog = Constants.latestBaseLog[base];
  if (!baseLog) return ret;

  if (exch && baseLog.exchangeBalances && baseLog.exchangeBalances[exch]) {
    ret.actual = baseLog.exchangeBalances[exch][act];
    ret.value = baseLog.exchangeBalances[exch][val];
    return ret;
  }

  //Sum all exchanges
  let actual = 0;
  let value = 0;
  for (const [exchange, balances] of Object.entries(baseLog.exchangeBalances)) {
    if (Constants.exchanges.includes(exchange)) {
      actual += balances[act];
      value += balances[val];
    }
  }

  return { actual, value };
}

function closeEnough(a: number, b: number): boolean {
  if (a == 0 && b == 0) {
    return true;
  }
  if (a == 0 || b == 0) {
    return false;
  }
  const ratio = a / b;
  return 0.99 < ratio && ratio < 1.01;
}
