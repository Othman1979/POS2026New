use std::{env,fs,hint::black_box};
fn encode(data:&[u8])->Vec<u8>{let height=data.len()/2304;let mut output=Vec::new();
for start in (0..height).step_by(256){let rows=std::cmp::min(256,height-start);let mut band=vec![0u8;8+72*rows];
band[..8].copy_from_slice(&[29,118,48,0,72,0,(rows&255)as u8,(rows>>8)as u8]);
for y in 0..rows{for x in 0..576{let s=((start+y)*576+x)*4;if data[s+3]<=50{continue;}
let l=data[s]as f64*0.299+data[s+1]as f64*0.587+data[s+2]as f64*0.114;
if l<130.0{band[8+y*72+(x>>3)]|=0x80>>(x&7);}}} output.extend_from_slice(&band);}output}
fn main(){let args:Vec<String>=env::args().collect();let data=fs::read(&args[1]).unwrap();let mut output=Vec::new();
for _ in 0..args[3].parse::<usize>().unwrap(){output=encode(black_box(&data));black_box(&output);}
fs::write(&args[2],output).unwrap();}
