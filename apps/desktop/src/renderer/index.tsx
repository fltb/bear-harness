import { render } from "solid-js/web";
import "./styles.css";
import { App } from "./App";
import { installRendererFaultReporting } from "./diagnostics";

installRendererFaultReporting();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

render(() => <App product={__PRODUCT_CONFIG__} />, root);
