#!/usr/bin/env node

/**
 * Benchmark comparison of formatPrecision implementations
 * Testing current vs optimized versions
 */

// Current implementation (hardcoded to 4 sig figs)
function formatPrecisionCurrent(value) {
  if (value === 0) {
    return 0;
  }
  
  // Calculate the order of magnitude
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  
  // Calculate decimal places needed for 4 significant figures
  const decimalPlaces = Math.max(0, 3 - magnitude);
  
  // Round to 4 significant figures
  const factor = Math.pow(10, decimalPlaces);
  const rounded = Math.round(value * factor) / factor;
  
  // If it's effectively an integer (accounting for floating point precision), return as integer
  if (Math.abs(rounded - Math.round(rounded)) < 1e-10) {
    return Math.round(rounded);
  }
  
  // Otherwise return the rounded float
  // Parse and re-format to remove trailing zeros
  const strVal = rounded.toFixed(decimalPlaces);
  return parseFloat(strVal);
}

// Optimized implementation with cascading ifs
function formatPrecisionOptimized(value) {
  if (value === 0) {
    return 0;
  }
  
  const absValue = Math.abs(value);
  let magnitude;
  
  // Cascading ifs to replace Math.log10 - optimized for common power values
  if (absValue >= 1000) {
    if (absValue >= 1000000) {
      if (absValue >= 1000000000) {
        if (absValue >= 10000000000) magnitude = 10;
        else magnitude = 9;
      } else if (absValue >= 100000000) {
        magnitude = 8;
      } else if (absValue >= 10000000) {
        magnitude = 7;
      } else {
        magnitude = 6;
      }
    } else {
      if (absValue >= 100000) magnitude = 5;
      else if (absValue >= 10000) magnitude = 4;
      else magnitude = 3;
    }
  } else if (absValue >= 1) {
    if (absValue >= 100) magnitude = 2;
    else if (absValue >= 10) magnitude = 1;
    else magnitude = 0;
  } else {
    // Less common: values < 1
    if (absValue >= 0.1) magnitude = -1;
    else if (absValue >= 0.01) magnitude = -2;
    else if (absValue >= 0.001) magnitude = -3;
    else if (absValue >= 0.0001) magnitude = -4;
    else if (absValue >= 0.00001) magnitude = -5;
    else if (absValue >= 0.000001) magnitude = -6;
    else {
      // Fallback for very small values
      magnitude = Math.floor(Math.log10(absValue));
    }
  }
  
  // For large integers (magnitude >= 4), preserve all digits
  if (magnitude >= 4) {
    // Round to nearest integer
    return Math.round(value);
  }
  
  // Calculate decimal places needed for 4 significant figures
  const decimalPlaces = 3 - magnitude;
  
  // Use lookup table for common powers of 10 (0-6 decimals covers most cases)
  const powers = [1, 10, 100, 1000, 10000, 100000, 1000000];
  const factor = decimalPlaces < powers.length ? powers[decimalPlaces] : Math.pow(10, decimalPlaces);
  
  const rounded = Math.round(value * factor) / factor;
  
  // Fast integer check
  const intVal = Math.round(rounded);
  if (Math.abs(rounded - intVal) < 1e-10) {
    return intVal;
  }
  
  // Avoid string conversion for trailing zeros removal
  // Numbers in JS automatically don't show trailing zeros
  return rounded;
}

// Ultra-optimized version (more aggressive optimizations)
function formatPrecisionUltra(value) {
  if (value === 0) return 0;
  
  const absValue = Math.abs(value);
  
  // Most common case: power values 100-10000W
  if (absValue >= 100 && absValue < 10000) {
    if (absValue >= 1000) {
      // 1000-9999: round to integer
      return Math.round(value);
    }
    // 100-999: 1 decimal place
    return Math.round(value * 10) / 10;
  }
  
  // Second most common: 10-100
  if (absValue >= 10 && absValue < 100) {
    // 2 decimal places
    return Math.round(value * 100) / 100;
  }
  
  // Large values >= 10000
  if (absValue >= 10000) {
    return Math.round(value);
  }
  
  // Small values 1-10
  if (absValue >= 1) {
    // 3 decimal places
    return Math.round(value * 1000) / 1000;
  }
  
  // Values < 1 (less common in power data)
  if (absValue >= 0.1) {
    return Math.round(value * 10000) / 10000;
  }
  if (absValue >= 0.01) {
    return Math.round(value * 100000) / 100000;
  }
  if (absValue >= 0.001) {
    return Math.round(value * 1000000) / 1000000;
  }
  
  // Very small values - use original algorithm
  const magnitude = Math.floor(Math.log10(absValue));
  const decimalPlaces = 3 - magnitude;
  const factor = Math.pow(10, decimalPlaces);
  return Math.round(value * factor) / factor;
}

// Test data generation
function generateTestData() {
  const data = [];
  
  // Typical power values (most common)
  for (let i = 0; i < 400; i++) {
    data.push(100 + Math.random() * 5000); // 100-5100W
  }
  
  // Battery SOC percentages
  for (let i = 0; i < 200; i++) {
    data.push(Math.random() * 100); // 0-100%
  }
  
  // Large values
  for (let i = 0; i < 100; i++) {
    data.push(10000 + Math.random() * 90000); // 10-100kW
  }
  
  // Negative values (export)
  for (let i = 0; i < 200; i++) {
    data.push(-Math.random() * 5000); // -5000 to 0W
  }
  
  // Small values
  for (let i = 0; i < 50; i++) {
    data.push(Math.random()); // 0-1
  }
  
  // Very small values
  for (let i = 0; i < 50; i++) {
    data.push(Math.random() * 0.001); // 0-0.001
  }
  
  return data;
}

// Benchmark function
function benchmark(fn, data, iterations, name) {
  // Warm up
  for (let i = 0; i < 1000; i++) {
    fn(data[i % data.length]);
  }
  
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    fn(data[i % data.length]);
  }
  const end = process.hrtime.bigint();
  
  const timeMs = Number(end - start) / 1000000;
  const opsPerSec = (iterations / (timeMs / 1000));
  const nsPerOp = Number(end - start) / iterations;
  
  return {
    name,
    timeMs,
    opsPerSec,
    nsPerOp
  };
}

// Verification that all implementations produce same results
function verifyImplementations(data) {
  console.log("Verifying implementations produce identical results...");
  let differences = 0;
  
  for (const value of data) {
    const current = formatPrecisionCurrent(value);
    const optimized = formatPrecisionOptimized(value);
    const ultra = formatPrecisionUltra(value);
    
    if (Math.abs(current - optimized) > 1e-10 || Math.abs(current - ultra) > 1e-10) {
      differences++;
      if (differences <= 5) {
        console.log(`  Difference found for ${value}:`);
        console.log(`    Current:   ${current}`);
        console.log(`    Optimized: ${optimized}`);
        console.log(`    Ultra:     ${ultra}`);
      }
    }
  }
  
  if (differences === 0) {
    console.log("✓ All implementations produce identical results\n");
  } else {
    console.log(`✗ Found ${differences} differences\n`);
  }
}

// Main benchmark
console.log("=============================================================");
console.log("FORMATPRECISION BENCHMARK COMPARISON");
console.log("=============================================================\n");

const testData = generateTestData();
console.log(`Test data: ${testData.length} realistic energy values\n`);

// Verify correctness
verifyImplementations(testData);

// Run benchmarks
const iterations = 1000000;
console.log(`Running ${iterations.toLocaleString()} iterations...\n`);

const results = [
  benchmark(formatPrecisionCurrent, testData, iterations, "Current (Math.log10)"),
  benchmark(formatPrecisionOptimized, testData, iterations, "Optimized (cascading if)"),
  benchmark(formatPrecisionUltra, testData, iterations, "Ultra (specialized)")
];

// Display results
console.log("RESULTS:");
console.log("--------");
results.forEach(r => {
  console.log(`${r.name.padEnd(25)} ${r.timeMs.toFixed(2)}ms   ${r.opsPerSec.toFixed(0).padStart(12)} ops/sec   ${r.nsPerOp.toFixed(1)}ns/op`);
});

// Calculate speedups
console.log("\nSPEEDUP vs Current:");
console.log("-------------------");
const baseline = results[0];
results.slice(1).forEach(r => {
  const speedup = baseline.timeMs / r.timeMs;
  const improvement = ((1 - r.timeMs / baseline.timeMs) * 100).toFixed(1);
  console.log(`${r.name.padEnd(25)} ${speedup.toFixed(2)}x faster (${improvement}% improvement)`);
});

// Test with array processing
console.log("\nARRAY PROCESSING TEST:");
console.log("----------------------");

function processArray(fn, data) {
  return data.map(fn);
}

const arraySize = 1000;
const testArray = testData.slice(0, arraySize);
const arrayIterations = 10000;

console.log(`Processing arrays of ${arraySize} elements, ${arrayIterations} iterations\n`);

const arrayResults = [];
["Current", "Optimized", "Ultra"].forEach((name, i) => {
  const fn = [formatPrecisionCurrent, formatPrecisionOptimized, formatPrecisionUltra][i];
  
  // Warm up
  for (let j = 0; j < 100; j++) {
    processArray(fn, testArray);
  }
  
  const start = process.hrtime.bigint();
  for (let j = 0; j < arrayIterations; j++) {
    processArray(fn, testArray);
  }
  const end = process.hrtime.bigint();
  
  const timeMs = Number(end - start) / 1000000;
  const arraysPerSec = arrayIterations / (timeMs / 1000);
  const msPerArray = timeMs / arrayIterations;
  
  arrayResults.push({ name, timeMs, arraysPerSec, msPerArray });
  console.log(`${name.padEnd(10)} ${timeMs.toFixed(2)}ms   ${arraysPerSec.toFixed(0).padStart(8)} arrays/sec   ${msPerArray.toFixed(3)}ms/array`);
});

console.log("\n=============================================================");
console.log("BENCHMARK COMPLETE");
console.log("=============================================================");