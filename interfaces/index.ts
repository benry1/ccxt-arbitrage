/*
 * Arbitrage Interfaces
 */

//buyon/sellon: exchange name
export interface SingleAssetArbitrage {
  base: string;
  quote: string;
  buyOn: string;
  sellOn: string;
}

export interface Orderbook {
  exchange: string;
  base: string;
  quote: string;
  timestamp: number;
  asks: Ask[];
  bids: Bid[];
  datetime: string;
}

export type Bid = Order;
export type Ask = Order;
export interface Order {
  price: number;
  volume: number;
}

/*
 * Arbitrage Interfaces
 */

export interface ArbitrageTrade {
  arbitrageId: number;
  dateTime: string;
  //Does not consider balance
  idealTrade: {
    buy: TradeAnalysis;
    sell: TradeAnalysis;
  };
  //Trimmed to fit our balance
  expectedTrade: {
    buy: TradeAnalysis;
    sell: TradeAnalysis;
  };
  base: string;
  quote: string;
  buy: TradeExecution;
  sell: TradeExecution;
  deltaBase: number;
  deltaBaseValue: number; //^Base * (buy_vwap + sell_vwap) / 2. Not "ideal" but I think there is no ideal. Error will be at most $1 in worst cases
  deltaQuote: number;
  totalFees: number; //Or best guess.
  estimatedDeltaValue: number; //deltaQuote + deltaBaseValue
}

export interface TradeExecution {
  exchange: string;
  expectedVwap: number;
  expectedBase: number;
  expectedQuote: number;
  orderId: string;
  response: {}; //Just raw response on creation. For seeing errors
  status: OrderStatus;
}

export interface OrderStatus {
  orderId: string;
  response: {}; //Raw orderStatus response. For seeing errors or miscalculations
  fee: number; //in USD
  executedBase: number;
  executedQuote: number;
  vwap: number; //vwap? i dont know how exchanges handle this response yet.
}

export interface RebalanceTrade {
  tradeId: number;
  dateTime: string;
  expectedTrade: TradeAnalysis[];
  base: string;
  quote: string;
  side: string;
  orders: TradeExecution[];
  deltaBase: number;
  deltaBaseValue: number; //Based on average VWAP. Rounding errors here.
  deltaQuote: number;
  vwap: number; //Needed because possibly several exchanges trading same side
  executedVolume: number;
  totalFees: number;
}

export interface ArbitrageAnalysis {
  buy: TradeAnalysis;
  sell: TradeAnalysis;
  idealProfit: number;
}

export interface TradeAnalysis {
  base: string;
  quote: string;
  exchange: string;
  side: string;
  volume: number;
  vwap: number;
  orderbookTS: number;
  offers: Order[];
}

export interface BaseLog {
  timestamp: number;
  dateTime: string;
  base: string;
  quote: string;
  initialInvestment: number; //Raw $ amount put in. Will change with capital additions
  initialInvestmentVwap: number; //Vwap of when investments happened. Used for buy/and/hold comparison
  sumQuote: number;
  sumBase: number;
  sumBaseValue: number;
  basePrice: number;
  exchangeBalances: { [exch: string]: ExchangeBalance };
  lastRebalanceTs: number;
  lastRebalancePrice: number;
  estimatedArbProfit: number; //"every trade estimated profits"
  estimatedRebalanceProfit: number; //"every rebalance ^basevalue-^quote-totalFees"
  estimatedFees: number;
}

export interface ExchangeBalance {
  exchange: string;
  quote: number;
  base: number;
  baseValue: number;
  exchangePrice: number;
}

export type CachedPoolS = {
  [base: string]: { [exch: string]: { [asset: string]: number } };
};
export type CachedExchangeBalances = {
  [exchange: string]: { [asset: string]: number };
};
