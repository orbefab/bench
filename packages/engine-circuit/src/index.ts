// Public surface of the circuit engine. Parts contribute stamps; they do not own a solver.
export { ADC_C_SH, adcCount, adcReading, holdVoltage } from "./adc";
export { BatteryElement, type BatteryParams } from "./battery";
export {
  D1N4148,
  diodeClamp,
  divider,
  LED_RED,
  ladder,
  nanoRail,
  POT_ALPHAS,
  POT_R,
  POT_RAILS,
  pinLed,
  pinPwm,
  potDivider,
  rcStep,
  SS14,
  TRACE_CASES,
  type TraceCase,
} from "./circuits";
export { Comparator } from "./comparator";
export type { Element } from "./element";
export {
  type Braking,
  BridgeMotor,
  bridgeMotor,
  Capacitor,
  CurrentLoad,
  capacitor,
  currentLoad,
  Diode,
  type DiodeParams,
  diode,
  Inductor,
  ISource,
  inductor,
  iSource,
  Resistor,
  resistor,
  type SupplyRegion,
  Switch,
  sw,
  TheveninLimit,
  thermalVoltage,
  thevenin,
  VSource,
  vSource,
} from "./elements";
export {
  Engine,
  gminFallbackCalls,
  type Method,
  type PowerReport,
  type Sample,
  type SolveOpts,
} from "./engine";
export { LawTable } from "./law-table";
export {
  dropoutAt,
  type LdoParams,
  LdoRegulator,
  ldoBias,
  ldoRegulated,
} from "./ldo";
export {
  AVERAGED_DUTY,
  averagedThevenin,
  DEFAULT_PIN_LEVEL,
  EDGE_EXACT,
  type PinLevel,
  type PinLevelName,
  type PwmSample,
  simulatePinPwm,
} from "./levels";
export { classifyNet, type NetLevel, type PortRole } from "./nets";
export {
  AVR_PIN,
  type AvrPinParams,
  avrPinParams,
  PIN_LEAK,
  PIN_ROFF,
  PIN_ROH,
  PIN_ROL,
  PIN_RPU,
  PIN_RPU_MAX,
  PIN_RPU_MIN,
  Pin,
  type PinMode,
} from "./pin";
export { PmosChannel } from "./pmos-switch";
export {
  MF_MSMF050,
  PtcFuseElement,
  type PtcFuseParams,
} from "./ptc-fuse";
export { type SpiceOpts, toSpice } from "./spice";
export { segmentIndex, segmentThevenin, tableVoltage } from "./table";
export { type Waveform, waveAt } from "./wave";
