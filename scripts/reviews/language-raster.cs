using System;using System.IO;
class Raster {
static byte[] Encode(byte[] data){int height=data.Length/2304;using(var output=new MemoryStream()){
for(int start=0;start<height;start+=256){int rows=Math.Min(256,height-start);byte[] band=new byte[8+72*rows];
byte[] header={29,118,48,0,72,0,(byte)(rows&255),(byte)(rows>>8)};Array.Copy(header,band,8);
for(int y=0;y<rows;y++)for(int x=0;x<576;x++){int s=((start+y)*576+x)*4;if(data[s+3]<=50)continue;
double l=data[s]*0.299+data[s+1]*0.587+data[s+2]*0.114;if(l<130)band[8+y*72+(x>>3)]|=(byte)(0x80>>(x&7));}
output.Write(band,0,band.Length);}return output.ToArray();}}
static void Main(string[] args){byte[] data=File.ReadAllBytes(args[0]),output=null;for(int i=0;i<int.Parse(args[2]);i++)output=Encode(data);File.WriteAllBytes(args[1],output);}
}
