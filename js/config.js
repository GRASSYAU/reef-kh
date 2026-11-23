// 設定：缸子與添加劑的資料集中在這裡，數值有變動時只改這個檔案

// 目標 KH（dKH）
export const TARGET_KH = 8.3;

// 整套系統的實際水量（公升），採保守估算
export const TANK_LITERS = 47;

// 添加劑的產品標示：每 labelLiters 公升的水加 labelMl 毫升原液，KH 提高 labelRise dKH
export const PRODUCT = {
  name: 'P. Ocean KH 添加液',
  labelMl: 7,
  labelLiters: 100,
  labelRise: 0.18,
};

// 稀釋方式：stockMl 毫升原液，加 RO/DI 水到總量 totalMl 毫升
export const DILUTION = {
  stockMl: 170,
  totalMl: 750,
};

// 滴定機校準：date 當天校準過，在那之前實際出水量只有設定值的一部分
// 校準前每 1 mL 實測為 0.8 至 0.9 mL，計算時取中間值 0.85，並用上下限估計誤差
export const CALIBRATION = {
  date: '2026-11-12',
  factor: 0.85,
  factorLow: 0.8,
  factorHigh: 0.9,
};

// 1 mL「稀釋液」加進這個缸子，理論上讓 KH 提高多少 dKH
export function khPerMl() {
  const perMlStockIn100L = PRODUCT.labelRise / PRODUCT.labelMl;           // 1 mL 原液在標示水量中的效果
  const perMlStock = perMlStockIn100L * (PRODUCT.labelLiters / TANK_LITERS); // 換算成這個缸子的水量
  return perMlStock * (DILUTION.stockMl / DILUTION.totalMl);               // 再乘上稀釋比例
}
