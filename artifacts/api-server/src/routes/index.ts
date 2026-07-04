import { Router, type IRouter } from "express";
import healthRouter from "./health";
import videosRouter from "./videos";

const router: IRouter = Router();

router.use(healthRouter);
router.use(videosRouter);

export default router;
