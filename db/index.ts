require("dotenv").config();
import { IDBController } from "./IDBController";
import { MongoController } from "./DBController";

export const db: IDBController = new MongoController(
  process.env.mongoUrl || "",
);
