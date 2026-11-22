//
//  TallyObjC.m
//  TallyStream
//

#import "TallyObjC.h"

NSString *TallyTryCatch(void (NS_NOESCAPE ^block)(void)) {
  @try {
    block();
    return nil;
  } @catch (NSException *exception) {
    return [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason ?: @""];
  }
}
